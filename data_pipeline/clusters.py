"""Regroupement spatial des adresses en groupes d'habitations (bourg, hameaux).

Deux adresses à moins de LINK_DISTANCE_M l'une de l'autre appartiennent au
même groupe (lien simple, de proche en proche). Ces groupes servent d'unités
indivisibles pour la proposition automatique et de référence pour signaler,
côté admin, un hameau coupé entre deux secteurs.
"""
from __future__ import annotations

import math
from collections import Counter

from common import haversine_m

LINK_DISTANCE_M = 80.0


def _find(parent: list[int], i: int) -> int:
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i


def assign_groups(addresses: list[dict]) -> None:
    """Ajoute `groupe_id` et `groupe` (nom lisible) à chaque adresse."""
    n = len(addresses)
    if n == 0:
        return
    parent = list(range(n))

    lat0 = sum(a["lat"] for a in addresses) / n
    cell_lat = LINK_DISTANCE_M / 111320.0
    cell_lon = LINK_DISTANCE_M / (111320.0 * math.cos(math.radians(lat0)))

    grid: dict[tuple[int, int], list[int]] = {}
    for i, a in enumerate(addresses):
        grid.setdefault((int(a["lat"] // cell_lat), int(a["lon"] // cell_lon)), []).append(i)

    for (gx, gy), members in grid.items():
        neighbours = [j for dx in (-1, 0, 1) for dy in (-1, 0, 1) for j in grid.get((gx + dx, gy + dy), [])]
        for i in members:
            ai = addresses[i]
            for j in neighbours:
                if j <= i:
                    continue
                aj = addresses[j]
                if haversine_m(ai["lat"], ai["lon"], aj["lat"], aj["lon"]) <= LINK_DISTANCE_M:
                    ri, rj = _find(parent, i), _find(parent, j)
                    if ri != rj:
                        parent[rj] = ri

    roots: dict[int, list[int]] = {}
    for i in range(n):
        roots.setdefault(_find(parent, i), []).append(i)

    used_names: Counter = Counter()
    ordered = sorted(roots.values(), key=len, reverse=True)
    for gid, members in enumerate(ordered, start=1):
        lieux = Counter(addresses[i]["lieu_dit"] for i in members if addresses[i].get("lieu_dit"))
        voies = Counter(addresses[i]["nom_voie"] for i in members if addresses[i].get("nom_voie"))
        base = (lieux or voies or Counter({f"Groupe {gid}": 1})).most_common(1)[0][0]
        used_names[base] += 1
        name = base if used_names[base] == 1 else f"{base} ({used_names[base]})"
        for i in members:
            addresses[i]["groupe_id"] = gid
            addresses[i]["groupe"] = name
