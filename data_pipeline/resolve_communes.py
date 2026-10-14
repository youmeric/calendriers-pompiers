"""Résolution des codes INSEE des communes à partir de leur nom / code postal."""
from __future__ import annotations

from common import http_get

GEO_API = "https://geo.api.gouv.fr/communes"


def resolve_commune(nom: str, code_postal: str) -> dict:
    """Retourne {code_insee, nom, centre:{lat,lon}} pour une commune donnée.

    Utilise l'API officielle geo.api.gouv.fr (découpage administratif INSEE).
    """
    resp = http_get(
        GEO_API,
        params={
            "nom": nom,
            "codePostal": code_postal,
            "fields": "nom,code,centre,codesPostaux,contour",
            "boost": "population",
        },
    )
    results = resp.json()
    if not results:
        raise RuntimeError(f"Commune introuvable: {nom} ({code_postal})")
    # Choix du meilleur résultat par correspondance exacte de nom (insensible à la casse/accents)
    best = None
    for r in results:
        if r["nom"].strip().lower() == nom.strip().lower():
            best = r
            break
    best = best or results[0]
    lon, lat = best["centre"]["coordinates"]
    return {
        "code_insee": best["code"],
        "nom": best["nom"],
        "centre": {"lat": lat, "lon": lon},
        "contour": best.get("contour"),
    }


if __name__ == "__main__":
    for nom in ("Courzieu", "Brussieu"):
        print(resolve_commune(nom, "69690"))
