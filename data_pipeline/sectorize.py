"""Découpage d'une commune en 4 secteurs équilibrés en temps de distribution.

Règles:
- Les adresses sont regroupées par unité atomique (hameau / lieu-dit, ou rue
  pour le bourg) : une unité n'est jamais coupée entre deux secteurs.
- Le bourg (unités accessibles à pied depuis la mairie, selon le réseau
  routier réel) forme un secteur unique, dédié au porte-à-porte pédestre.
- Les unités restantes (hameaux) sont réparties en 3 secteurs contigus
  (balayage angulaire autour de la mairie) choisis pour minimiser l'écart de
  temps de distribution estimé entre les 3 secteurs.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from build_graph import RoadNetwork
from common import bearing_deg, haversine_m
from geometry import buffer_hull_outward, convex_hull

# --- Paramètres métier (ajustables) -----------------------------------------
WALK_RADIUS_M = 700          # rayon à pied depuis la mairie pour le secteur "Bourg"
HANDLING_MIN_PER_ADDRESS = 1.5   # minutes passées à chaque porte
WALK_SPEED_KMH = 4.5
DRIVE_SPEED_KMH = 35.0

SECTOR_COLORS = ["#e6550d", "#31a354", "#3182bd", "#756bb1"]
COMPASS = [
    (0, "Nord"), (45, "Nord-Est"), (90, "Est"), (135, "Sud-Est"),
    (180, "Sud"), (225, "Sud-Ouest"), (270, "Ouest"), (315, "Nord-Ouest"),
]


@dataclass
class Unit:
    key: str
    label: str
    addresses: list[dict]
    lat: float = 0.0
    lon: float = 0.0
    dist_mairie_m: float = 0.0
    bearing_deg: float = 0.0

    @property
    def count(self) -> int:
        return len(self.addresses)


def _group_units(addresses: list[dict]) -> list[Unit]:
    """Une unité = un groupe d'habitations (voir clusters.assign_groups)."""
    groups: dict[int, list[dict]] = {}
    for addr in addresses:
        groups.setdefault(addr["groupe_id"], []).append(addr)

    units = []
    for gid, addrs in groups.items():
        lat = sum(a["lat"] for a in addrs) / len(addrs)
        lon = sum(a["lon"] for a in addrs) / len(addrs)
        units.append(Unit(key=str(gid), label=addrs[0]["groupe"], addresses=addrs, lat=lat, lon=lon))
    return units


def _compass_label(bearing: float) -> str:
    best = min(COMPASS, key=lambda c: min(abs(c[0] - bearing), 360 - abs(c[0] - bearing)))
    return best[1]


# Au-delà de ce rayon on n'explore plus le réseau routier : les paires éloignées
# n'interviennent pas dans les arbres de tournée et passent en estimation directe.
PAIRWISE_CUTOFF_M = 4000.0


def _pairwise_distances(units: list[Unit], network: RoadNetwork) -> list[list[float]]:
    """Matrice n×n des distances par la route entre groupes d'habitations."""
    n = len(units)
    nodes = [network.nearest_node(u.lat, u.lon) for u in units]
    dmat = [[0.0] * n for _ in range(n)]
    for i, ui in enumerate(units):
        cache = network.distances_from(ui.lat, ui.lon, cutoff=PAIRWISE_CUTOFF_M)
        for j in range(i + 1, n):
            uj = units[j]
            dist, _ = network.network_distance(ui.lat, ui.lon, uj.lat, uj.lon,
                                               distances_cache=cache, node2=nodes[j])
            dmat[i][j] = dmat[j][i] = dist
    return dmat


def _mst_length(indices: list[int], dmat: list[list[float]]) -> float:
    """Longueur de l'arbre couvrant minimal (Prim, O(k²))."""
    if len(indices) <= 1:
        return 0.0
    first, rest = indices[0], indices[1:]
    best = {j: dmat[first][j] for j in rest}
    total = 0.0
    while best:
        j = min(best, key=best.get)
        total += best.pop(j)
        row = dmat[j]
        for k in best:
            if row[k] < best[k]:
                best[k] = row[k]
    return total


def _travel_minutes(meters: float) -> float:
    return (meters / 1000.0) / DRIVE_SPEED_KMH * 60.0


def _group_time_minutes(indices: list[int], units: list[Unit], dmat: list[list[float]],
                         mairie_dist: dict[int, float]) -> float:
    if not indices:
        return 0.0
    n_addr = sum(units[i].count for i in indices)
    travel_m = _mst_length(indices, dmat) + min(mairie_dist[i] for i in indices)
    return n_addr * HANDLING_MIN_PER_ADDRESS + _travel_minutes(travel_m)


def _arc_times(order: list[int], units: list[Unit], dmat: list[list[float]],
               mairie_dist: dict[int, float]) -> list[list[float]]:
    """times[s][L] = temps estimé de l'arc de L groupes commençant en s.

    L'arbre de tournée est construit de proche en proche (chaque groupe ajouté
    est relié au plus proche déjà présent) : approximation de l'arbre couvrant
    minimal en O(n³) au total au lieu de O(n⁵)."""
    n = len(order)
    times = [[0.0] * n for _ in range(n)]
    for s in range(n):
        members: list[int] = []
        tree = 0.0
        n_addr = 0
        to_mairie = float("inf")
        for length in range(1, n):
            u = order[(s + length - 1) % n]
            if members:
                row = dmat[u]
                tree += min(row[m] for m in members)
            members.append(u)
            n_addr += units[u].count
            to_mairie = min(to_mairie, mairie_dist[u])
            times[s][length] = n_addr * HANDLING_MIN_PER_ADDRESS + _travel_minutes(tree + to_mairie)
    return times


def _best_contiguous_split(order: list[int], units: list[Unit], dmat: list[list[float]],
                            mairie_dist: dict[int, float]) -> tuple[list[list[int]], float]:
    """Cherche la rotation et les 2 points de coupe qui divisent l'ordre
    circulaire `order` en 3 arcs contigus les plus équilibrés en temps."""
    n = len(order)
    if n < 3:
        return [[i] for i in order] + [[] for _ in range(3 - n)], 0.0

    times = _arc_times(order, units, dmat, mairie_dist)
    best: tuple[int, int, int] | None = None
    best_score = float("inf")
    for rot in range(n):
        for cut1 in range(1, n - 1):
            t1 = times[rot][cut1]
            s2 = (rot + cut1) % n
            # t2 croît et t3 décroît avec cut2 : on cherche leur croisement par dichotomie
            lo, hi = cut1 + 1, n - 1
            while lo < hi:
                mid = (lo + hi) // 2
                if times[s2][mid - cut1] < times[(rot + mid) % n][n - mid]:
                    lo = mid + 1
                else:
                    hi = mid
            for cut2 in (lo - 1, lo, lo + 1):
                if not cut1 < cut2 < n:
                    continue
                t2 = times[s2][cut2 - cut1]
                t3 = times[(rot + cut2) % n][n - cut2]
                score = max(t1, t2, t3) - min(t1, t2, t3)
                if score < best_score:
                    best_score = score
                    best = (rot, cut1, cut2)

    rot, cut1, cut2 = best
    seq = order[rot:] + order[:rot]
    return [seq[:cut1], seq[cut1:cut2], seq[cut2:]], best_score


def _hull_for_units(indices: list[int], units: list[Unit]) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for i in indices:
        for addr in units[i].addresses:
            pts.append((addr["lat"], addr["lon"]))
        pts.append((units[i].lat, units[i].lon))
    if len(pts) < 3:
        # polygone minimal autour d'un point isolé
        lat, lon = pts[0] if pts else (0.0, 0.0)
        d = 0.0005
        return [(lat - d, lon - d), (lat - d, lon + d), (lat + d, lon + d), (lat + d, lon - d)]
    hull = convex_hull(pts)
    clat = sum(p[0] for p in pts) / len(pts)
    clon = sum(p[1] for p in pts) / len(pts)
    return buffer_hull_outward(hull, (clat, clon))


def build_sectors(addresses: list[dict], mairie: dict, network: RoadNetwork) -> dict:
    units = _group_units(addresses)
    mairie_caches_origin = network.distances_from(mairie["lat"], mairie["lon"])

    for u in units:
        u.dist_mairie_m, _ = network.network_distance(
            mairie["lat"], mairie["lon"], u.lat, u.lon, distances_cache=mairie_caches_origin
        )
        # on retient aussi la distance de l'adresse la plus proche de la mairie dans l'unité
        closest = min(
            network.network_distance(mairie["lat"], mairie["lon"], a["lat"], a["lon"],
                                      distances_cache=mairie_caches_origin)[0]
            for a in u.addresses
        )
        u.dist_mairie_m = min(u.dist_mairie_m, closest)
        u.bearing_deg = bearing_deg(mairie["lat"], mairie["lon"], u.lat, u.lon)

    bourg_units = [u for u in units if u.dist_mairie_m <= WALK_RADIUS_M]
    other_units = [u for u in units if u.dist_mairie_m > WALK_RADIUS_M]

    if not other_units:
        # commune minuscule : tout le reste bascule quand même en secteurs motorisés
        other_units = bourg_units[1:]
        bourg_units = bourg_units[:1]

    sectors = []

    bourg_idx = list(range(len(bourg_units)))
    bourg_time = sum(u.count for u in bourg_units) * HANDLING_MIN_PER_ADDRESS \
        + (max((u.dist_mairie_m for u in bourg_units), default=0) / 1000.0) / WALK_SPEED_KMH * 60.0
    sectors.append({
        "nom": "Secteur 1 – Le Bourg (à pied)",
        "couleur": SECTOR_COLORS[0],
        "mode": "pied",
        "temps_estime_min": round(bourg_time, 1),
        "hameaux": sorted({u.label for u in bourg_units}),
        "nb_adresses": sum(u.count for u in bourg_units),
        "polygon": _hull_for_units(bourg_idx, bourg_units) if bourg_units else [],
    })

    if other_units:
        dmat = _pairwise_distances(other_units, network)
        mairie_dist = {i: u.dist_mairie_m for i, u in enumerate(other_units)}
        order = sorted(range(len(other_units)), key=lambda i: other_units[i].bearing_deg)
        groups, _score = _best_contiguous_split(order, other_units, dmat, mairie_dist)

        for n, group in enumerate(groups, start=2):
            if not group:
                continue
            mean_bearing = sum(other_units[i].bearing_deg for i in group) / len(group)
            by_size = sorted(group, key=lambda i: other_units[i].count, reverse=True)
            hameaux = list(dict.fromkeys(other_units[i].label for i in by_size))
            nom_zone = _compass_label(mean_bearing)
            time_min = _group_time_minutes(group, other_units, dmat, mairie_dist)
            sectors.append({
                "nom": f"Secteur {n} – {nom_zone} ({', '.join(hameaux[:3])}{'…' if len(hameaux) > 3 else ''})",
                "couleur": SECTOR_COLORS[(n - 1) % len(SECTOR_COLORS)],
                "mode": "voiture",
                "temps_estime_min": round(time_min, 1),
                "hameaux": hameaux,
                "nb_adresses": sum(other_units[i].count for i in group),
                "polygon": _hull_for_units(group, other_units),
            })

    return {"sectors": sectors}
