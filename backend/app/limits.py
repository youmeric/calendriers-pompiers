"""Description en mots de la limite d'un secteur : quelles routes son contour suit.

On parcourt le contour dans le sens des aiguilles d'une montre en partant de
son point le plus au nord, on échantillonne un point tous les STEP_M mètres et
on cherche la route la plus proche de chaque point (index spatial en grille).
Les tronçons consécutifs le long d'une même route sont regroupés.
"""
from __future__ import annotations

import math

STEP_M = 20.0
NEAR_ROAD_M = 35.0
CELL_M = 60.0
MIN_RUN_M = 60.0
CONTOUR_PENALTY_M = 10.0  # une route qui longe la limite communale l'emporte sur celle-ci
PARALLEL_COS = 0.8         # ~37° : au-delà, la limite coupe la route au lieu de la suivre
CROSSING_M = 15.0

OFF_ROAD = "hors route (à travers champs)"
COMMUNE_LIMIT = "limite de la commune"

UNNAMED = {
    "track": "chemin de terre sans nom",
    "path": "sentier sans nom",
    "footway": "sentier sans nom",
    "bridleway": "sentier sans nom",
    "cycleway": "piste cyclable",
    "service": "voie de desserte sans nom",
    "residential": "rue sans nom",
    "unclassified": "route sans nom",
}


def road_label(road: dict) -> str:
    name, ref = road.get("nom", "").strip(), road.get("ref", "").strip()
    if name and ref:
        return f"{name} ({ref})"
    return name or ref or UNNAMED.get(road.get("type", ""), "route sans nom")


class _Projector:
    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = 111320.0 * math.cos(math.radians(lat0))
        self.ky = 110540.0

    def __call__(self, lat: float, lon: float) -> tuple[float, float]:
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)


def _seg_dist(px, py, ax, ay, bx, by) -> float:
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


class RoadIndex:
    """Index en grille des segments de route (et de la limite communale)."""

    def __init__(self, roads: list[dict], contour: dict | None, lat0: float, lon0: float):
        self.proj = _Projector(lat0, lon0)
        self.grid: dict[tuple[int, int], list[tuple]] = {}
        for road in roads:
            pts = [self.proj(lat, lon) for lat, lon in road["points"]]
            self._add_line(pts, road_label(road), 0.0)
        for ring in _contour_rings(contour):
            pts = [self.proj(lat, lon) for lon, lat in ring]
            self._add_line(pts, COMMUNE_LIMIT, CONTOUR_PENALTY_M)

    def _add_line(self, pts, label, penalty):
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            seg = (ax, ay, bx, by, label, penalty)
            x0, x1 = sorted((ax, bx))
            y0, y1 = sorted((ay, by))
            for gx in range(int(math.floor((x0 - NEAR_ROAD_M) / CELL_M)), int(math.floor((x1 + NEAR_ROAD_M) / CELL_M)) + 1):
                for gy in range(int(math.floor((y0 - NEAR_ROAD_M) / CELL_M)), int(math.floor((y1 + NEAR_ROAD_M) / CELL_M)) + 1):
                    self.grid.setdefault((gx, gy), []).append(seg)

    def label_at(self, x: float, y: float, ux: float, uy: float) -> tuple[str, str | None]:
        """(route suivie, route coupée) au point (x, y) d'une limite de direction (ux, uy).

        Une route n'est « suivie » que si elle est à peu près parallèle à la
        limite ; sinon la limite la coupe simplement (repère utile sur le terrain)."""
        best, best_d = OFF_ROAD, NEAR_ROAD_M
        crossing, crossing_d = None, CROSSING_M
        for ax, ay, bx, by, label, penalty in self.grid.get((int(math.floor(x / CELL_M)), int(math.floor(y / CELL_M))), ()):
            seg_len = math.hypot(bx - ax, by - ay)
            if seg_len == 0:
                continue
            d = _seg_dist(x, y, ax, ay, bx, by)
            parallel = abs(((bx - ax) * ux + (by - ay) * uy) / seg_len) >= PARALLEL_COS
            if parallel and d + penalty <= best_d:
                best, best_d = label, d + penalty
            elif not parallel and label != COMMUNE_LIMIT and d <= crossing_d:
                crossing, crossing_d = label, d
        return best, crossing


def _contour_rings(contour: dict | None):
    if not contour:
        return []
    if contour.get("type") == "Polygon":
        return contour["coordinates"][:1]
    if contour.get("type") == "MultiPolygon":
        return [poly[0] for poly in contour["coordinates"]]
    return []


def _absorb(target: list, run: list) -> None:
    target[1] += run[1]
    target[2].extend(c for c in run[2] if c not in target[2])


def _smooth(runs: list[list]) -> list[list]:
    """Fusionne les tronçons trop courts (bruit aux carrefours).
    Un tronçon = [libellé, longueur, routes coupées]."""
    changed = True
    while changed and len(runs) > 1:
        changed = False
        # tronçons voisins identiques
        merged = [runs[0]]
        for run in runs[1:]:
            if merged[-1][0] == run[0]:
                _absorb(merged[-1], run)
                changed = True
            else:
                merged.append(run)
        runs = merged
        if len(runs) > 1 and runs[0][0] == runs[-1][0]:
            last = runs.pop()
            last[2].extend(c for c in runs[0][2] if c not in last[2])
            runs[0][1] += last[1]
            runs[0][2] = last[2]
            changed = True
        # plus court tronçon sous le seuil : absorbé par son plus long voisin
        shortest = min(range(len(runs)), key=lambda i: runs[i][1])
        if len(runs) > 1 and runs[shortest][1] < MIN_RUN_M:
            prev_i, next_i = (shortest - 1) % len(runs), (shortest + 1) % len(runs)
            target = prev_i if runs[prev_i][1] >= runs[next_i][1] else next_i
            _absorb(runs[target], runs[shortest])
            runs.pop(shortest)
            changed = True
    return runs


def describe_limit(polygon: list, index: RoadIndex) -> list[dict]:
    """Retourne [{"nom": ..., "m": longueur}, ...] dans le sens horaire depuis le nord."""
    if len(polygon) < 3:
        return []
    pts = [index.proj(lat, lon) for lat, lon in polygon]
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    area2 = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))
    if area2 > 0:  # sens trigonométrique -> on inverse pour tourner dans le sens horaire
        pts.reverse()
    north = max(range(len(pts)), key=lambda i: pts[i][1])
    pts = pts[north:] + pts[:north]

    runs: list[list] = []
    for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1]):
        length = math.hypot(bx - ax, by - ay)
        if length == 0:
            continue
        ux, uy = (bx - ax) / length, (by - ay) / length
        steps = max(1, int(round(length / STEP_M)))
        for k in range(steps):
            t = (k + 0.5) / steps
            label, crossing = index.label_at(ax + t * (bx - ax), ay + t * (by - ay), ux, uy)
            if not runs or runs[-1][0] != label:
                runs.append([label, 0.0, []])
            runs[-1][1] += length / steps
            if crossing and crossing != label and crossing not in runs[-1][2]:
                runs[-1][2].append(crossing)

    runs = _smooth(runs)
    out = []
    for i, (label, length, cuts) in enumerate(runs):
        # la route du tronçon précédent/suivant est un simple angle, pas un croisement
        neighbours = {runs[i - 1][0], runs[(i + 1) % len(runs)][0], label}
        out.append({"nom": label, "m": int(round(length)), "croise": [c for c in cuts if c not in neighbours]})
    return out


PART_MARKER = "__partie__"
ENCLAVE_MARKER = "__enclave__"


def describe_limit_polys(polys: list[list], index: RoadIndex) -> list[dict]:
    """Comme describe_limit, pour un secteur en un ou plusieurs morceaux,
    éventuellement percés d'enclaves (zones au milieu qui n'en font pas partie).
    Chaque morceau est précédé de {"nom": "__partie__", "partie": k} (s'il y en a
    plusieurs) et chaque enclave de {"nom": "__enclave__", "partie": k}."""
    out: list[dict] = []
    several = len(polys) > 1
    for k, poly in enumerate(polys, start=1):
        if not poly:
            continue
        if several:
            out.append({"nom": PART_MARKER, "partie": k, "m": 0, "croise": []})
        out.extend(describe_limit(poly[0], index))
        for hole in poly[1:]:
            out.append({"nom": ENCLAVE_MARKER, "partie": k, "m": 0, "croise": []})
            out.extend(describe_limit(hole, index))
    return out
