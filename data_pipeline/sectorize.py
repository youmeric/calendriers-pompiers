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
    groups: dict[str, list[dict]] = {}
    for addr in addresses:
        if addr.get("lieu_dit"):
            key = f"LD::{addr['lieu_dit']}"
            label = addr["lieu_dit"]
        elif addr.get("nom_voie"):
            key = f"RUE::{addr['nom_voie']}"
            label = addr["nom_voie"]
        else:
            key = "RUE::Bourg"
            label = "Bourg"
        groups.setdefault(key, []).append(addr)

    units = []
    for key, addrs in groups.items():
        lat = sum(a["lat"] for a in addrs) / len(addrs)
        lon = sum(a["lon"] for a in addrs) / len(addrs)
        units.append(Unit(key=key, label=addrs[0].get("lieu_dit") or addrs[0].get("nom_voie") or "Bourg",
                           addresses=addrs, lat=lat, lon=lon))
    return units


def _compass_label(bearing: float) -> str:
    best = min(COMPASS, key=lambda c: min(abs(c[0] - bearing), 360 - abs(c[0] - bearing)))
    return best[1]


def _pairwise_distances(units: list[Unit], network: RoadNetwork) -> dict[tuple[int, int], float]:
    dmat: dict[tuple[int, int], float] = {}
    caches = [network.distances_from(u.lat, u.lon) for u in units]
    for i, ui in enumerate(units):
        for j, uj in enumerate(units):
            if j <= i:
                continue
            dist, _ = network.network_distance(ui.lat, ui.lon, uj.lat, uj.lon, distances_cache=caches[i])
            dmat[(i, j)] = dmat[(j, i)] = dist
    return dmat


def _mst_length(indices: list[int], dmat: dict[tuple[int, int], float]) -> float:
    if len(indices) <= 1:
        return 0.0
    in_tree = {indices[0]}
    remaining = set(indices[1:])
    total = 0.0
    while remaining:
        best = None
        for a in in_tree:
            for b in remaining:
                d = dmat[(a, b)]
                if best is None or d < best[0]:
                    best = (d, b)
        total += best[0]
        in_tree.add(best[1])
        remaining.remove(best[1])
    return total


def _group_time_minutes(indices: list[int], units: list[Unit], dmat: dict[tuple[int, int], float],
                         mairie_dist: dict[int, float]) -> float:
    if not indices:
        return 0.0
    n_addr = sum(units[i].count for i in indices)
    handling = n_addr * HANDLING_MIN_PER_ADDRESS
    travel_m = _mst_length(indices, dmat) + min(mairie_dist[i] for i in indices)
    travel_min = (travel_m / 1000.0) / DRIVE_SPEED_KMH * 60.0
    return handling + travel_min


def _best_contiguous_split(order: list[int], units: list[Unit], dmat: dict[tuple[int, int], float],
                            mairie_dist: dict[int, float]) -> tuple[list[list[int]], float]:
    """Cherche, pour un ordre circulaire donné, la meilleure rotation + les 2
    points de coupe qui divisent `order` en 3 groupes contigus les plus
    équilibrés en temps (minimise l'écart max-min)."""
    n = len(order)
    best_groups: list[list[int]] | None = None
    best_score = float("inf")

    for rot in range(n):
        seq = order[rot:] + order[:rot]
        for cut1 in range(1, n - 1):
            for cut2 in range(cut1 + 1, n):
                g1, g2, g3 = seq[:cut1], seq[cut1:cut2], seq[cut2:]
                if not g1 or not g2 or not g3:
                    continue
                t1 = _group_time_minutes(g1, units, dmat, mairie_dist)
                t2 = _group_time_minutes(g2, units, dmat, mairie_dist)
                t3 = _group_time_minutes(g3, units, dmat, mairie_dist)
                score = max(t1, t2, t3) - min(t1, t2, t3)
                if score < best_score:
                    best_score = score
                    best_groups = [g1, g2, g3]
    return best_groups or [order, [], []], best_score


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
        "addresses": [a for u in bourg_units for a in u.addresses],
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
            hameaux = sorted({other_units[i].label for i in group})
            nom_zone = _compass_label(mean_bearing)
            time_min = _group_time_minutes(group, other_units, dmat, mairie_dist)
            sectors.append({
                "nom": f"Secteur {n} – {nom_zone} ({', '.join(hameaux[:3])}{'…' if len(hameaux) > 3 else ''})",
                "couleur": SECTOR_COLORS[(n - 1) % len(SECTOR_COLORS)],
                "mode": "voiture",
                "temps_estime_min": round(time_min, 1),
                "hameaux": hameaux,
                "addresses": [a for i in group for a in other_units[i].addresses],
                "polygon": _hull_for_units(group, other_units),
            })

    for sector in sectors:
        for addr in sector["addresses"]:
            label_parts = [addr.get("numero", ""), addr.get("rep", ""), addr.get("nom_voie") or addr.get("lieu_dit", "")]
            addr["label"] = " ".join(p for p in label_parts if p).strip()
            addr["secteur"] = sector["nom"]

    return {"sectors": sectors}
