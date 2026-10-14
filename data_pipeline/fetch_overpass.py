"""Récupération de la mairie, du réseau routier et des bâtiments via Overpass (OSM)."""
from __future__ import annotations

from common import http_post, read_cache, write_cache

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

MAIRIE_QUERY = """
[out:json][timeout:90];
area["ref:INSEE"="{insee}"]["boundary"="administrative"]->.commune;
(
  node(area.commune)["amenity"="townhall"];
  way(area.commune)["amenity"="townhall"];
);
out center;
"""

ROADS_QUERY = """
[out:json][timeout:120];
area["ref:INSEE"="{insee}"]["boundary"="administrative"]->.commune;
way(area.commune)["highway"]["highway"!~"^(proposed|construction|abandoned|razed)$"];
out geom;
"""

BUILDINGS_QUERY = """
[out:json][timeout:120];
area["ref:INSEE"="{insee}"]["boundary"="administrative"]->.commune;
way(area.commune)["building"];
out geom;
"""


def _run(query: str, insee: str, cache_name: str, use_cache: bool = True) -> dict:
    if use_cache:
        cached = read_cache(cache_name)
        if cached is not None:
            return cached
    resp = http_post(OVERPASS_URL, data=query.format(insee=insee))
    data = resp.json()
    write_cache(cache_name, data)
    return data


def fetch_mairie(insee: str, use_cache: bool = True) -> dict | None:
    data = _run(MAIRIE_QUERY, insee, f"overpass-mairie-{insee}.json", use_cache)
    elements = data.get("elements", [])
    if not elements:
        return None
    el = elements[0]
    if "center" in el:
        return {"lat": el["center"]["lat"], "lon": el["center"]["lon"]}
    if "lat" in el:
        return {"lat": el["lat"], "lon": el["lon"]}
    return None


def fetch_roads(insee: str, use_cache: bool = True) -> list[dict]:
    data = _run(ROADS_QUERY, insee, f"overpass-roads-{insee}.json", use_cache)
    ways = []
    for el in data.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        ways.append(
            {
                "id": el["id"],
                "tags": el.get("tags", {}),
                "nodes": [(pt["lat"], pt["lon"]) for pt in el["geometry"] if pt],
            }
        )
    return ways


def fetch_buildings(insee: str, use_cache: bool = True) -> list[dict]:
    data = _run(BUILDINGS_QUERY, insee, f"overpass-buildings-{insee}.json", use_cache)
    ways = []
    for el in data.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        ways.append(
            {
                "id": el["id"],
                "nodes": [(pt["lat"], pt["lon"]) for pt in el["geometry"] if pt],
            }
        )
    return ways


if __name__ == "__main__":
    import sys

    code = sys.argv[1] if len(sys.argv) > 1 else "69089"
    print("Mairie:", fetch_mairie(code))
    roads = fetch_roads(code)
    print(f"{len(roads)} segments de route")
    buildings = fetch_buildings(code)
    print(f"{len(buildings)} bâtiments")
