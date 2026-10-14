"""Petites fonctions géométriques (sans dépendance lourde type shapely)."""
from __future__ import annotations


def convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Enveloppe convexe (monotone chain). points = [(lat, lon), ...]."""
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)

    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)

    return lower[:-1] + upper[:-1]


def buffer_hull_outward(hull: list[tuple[float, float]], centroid: tuple[float, float],
                         margin_ratio: float = 0.08) -> list[tuple[float, float]]:
    """Dilate légèrement l'enveloppe autour de son centroïde pour que les bâtiments
    en bord de secteur restent visuellement à l'intérieur du polygone affiché."""
    clat, clon = centroid
    out = []
    for lat, lon in hull:
        out.append((clat + (lat - clat) * (1 + margin_ratio), clon + (lon - clon) * (1 + margin_ratio)))
    return out
