"""Géométrie des secteurs.

Format canonique d'un secteur (comme un MultiPolygon GeoJSON, mais en [lat, lon]) :
    [ [contour_extérieur, enclave1, enclave2, ...],  # morceau 1
      [contour_extérieur, ...],                       # morceau 2
      ... ]
où chaque contour est [[lat, lon], ...].
"""
from __future__ import annotations


def point_in_ring(lat: float, lon: float, ring: list) -> bool:
    """Test d'appartenance par lancer de rayon. ring = [[lat, lon], ...]."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        yi, xi = ring[i][0], ring[i][1]
        yj, xj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_cross:
                inside = not inside
        j = i
    return inside


def _depth(value) -> int:
    d = 0
    while isinstance(value, list) and value:
        value = value[0]
        d += 1
    return d


def normalize_polys(polygon: list) -> list[list[list]]:
    """Accepte les formats successifs et renvoie le format canonique :
    - contour seul [[lat, lon], ...]                (profondeur 2, ancien format)
    - liste de contours extérieurs                  (profondeur 3)
    - liste de morceaux avec enclaves               (profondeur 4, canonique)"""
    depth = _depth(polygon)
    if depth == 2:
        return [[polygon]]
    if depth == 3:
        return [[ring] for ring in polygon]
    if depth == 4:
        return polygon
    return []


def point_in_polys(lat: float, lon: float, polys: list) -> bool:
    for poly in polys:
        if poly and point_in_ring(lat, lon, poly[0]) and not any(point_in_ring(lat, lon, h) for h in poly[1:]):
            return True
    return False
