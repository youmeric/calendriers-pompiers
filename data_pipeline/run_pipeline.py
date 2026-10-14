"""Point d'entrée du pipeline: récupère les données et génère les secteurs.

Usage:
    python run_pipeline.py                  # Courzieu + Brussieu (défaut)
    python run_pipeline.py --no-cache        # force le re-téléchargement
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from build_graph import RoadNetwork
from common import slugify
from fetch_ban import fetch_ban_addresses
from fetch_overpass import fetch_buildings, fetch_mairie, fetch_roads
from resolve_communes import resolve_commune
from sectorize import build_sectors

COMMUNES = [
    {"nom": "Courzieu", "code_postal": "69690"},
    {"nom": "Brussieu", "code_postal": "69690"},
]

OUTPUT_DIR = Path(os.environ.get("SECTORS_OUTPUT_DIR") or
                   (Path(__file__).resolve().parent.parent / "backend" / "app" / "data"))


def run(use_cache: bool = True) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    index = []

    for commune_def in COMMUNES:
        nom, cp = commune_def["nom"], commune_def["code_postal"]
        print(f"== {nom} ({cp}) ==")
        commune = resolve_commune(nom, cp)
        insee = commune["code_insee"]
        print(f"  code INSEE: {insee}")

        mairie = fetch_mairie(insee, use_cache=use_cache)
        if mairie is None:
            mairie = {"lat": commune["centre"]["lat"], "lon": commune["centre"]["lon"]}
            print("  ! mairie non trouvée dans OSM, utilisation du centre commune en repli")
        else:
            print(f"  mairie: {mairie}")

        addresses = fetch_ban_addresses(insee, use_cache=use_cache)
        print(f"  {len(addresses)} adresses BAN")

        roads = fetch_roads(insee, use_cache=use_cache)
        print(f"  {len(roads)} segments de route OSM")

        buildings = fetch_buildings(insee, use_cache=use_cache)
        print(f"  {len(buildings)} bâtiments OSM")

        network = RoadNetwork(roads)
        result = build_sectors(addresses, mairie, network)

        slug = slugify(nom)
        payload = {
            "commune": {
                "nom": commune["nom"],
                "code_insee": insee,
                "code_postal": cp,
                "mairie": mairie,
                "contour": commune.get("contour"),
            },
            "sectors": result["sectors"],
            "buildings": [w["nodes"] for w in buildings],
        }
        out_path = OUTPUT_DIR / f"{slug}.json"
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        print(f"  -> {out_path} ({sum(len(s['addresses']) for s in result['sectors'])} adresses réparties"
              f" en {len(result['sectors'])} secteurs)")

        index.append({"slug": slug, "nom": commune["nom"]})

    with open(OUTPUT_DIR / "index.json", "w", encoding="utf-8") as fh:
        json.dump({"communes": index}, fh, ensure_ascii=False)
    print("Pipeline terminé.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-cache", action="store_true", help="forcer le re-téléchargement des données sources")
    args = parser.parse_args()
    run(use_cache=not args.no_cache)
