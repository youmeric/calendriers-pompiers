"""Récupération des adresses officielles depuis la Base Adresse Nationale (BAN)."""
from __future__ import annotations

import csv
import gzip
import io

from common import cache_path, http_get, read_cache, write_cache

# La BAN publie un export CSV complet par commune. Le chemin exact a pu
# changer depuis la rédaction de ce script (vérifier sur
# https://adresse.data.gouv.fr si le téléchargement échoue) : on tente
# plusieurs variantes connues avant d'abandonner.
BAN_CSV_URL_CANDIDATES = [
    "https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-{code_insee}.csv.gz",
    "https://adresse.data.gouv.fr/data/ban/adresses/latest/csv-bal/adresses-{code_insee}.csv.gz",
]


def _download_ban_csv(code_insee: str):
    last_err = None
    for pattern in BAN_CSV_URL_CANDIDATES:
        url = pattern.format(code_insee=code_insee)
        try:
            return http_get(url, timeout=120, retries=1)
        except RuntimeError as exc:
            last_err = exc
    raise RuntimeError(
        "Impossible de télécharger l'export BAN pour "
        f"{code_insee}. URLs essayées: {[p.format(code_insee=code_insee) for p in BAN_CSV_URL_CANDIDATES]}. "
        f"Vérifiez le chemin actuel sur https://adresse.data.gouv.fr (dernier essai: {last_err})"
    )


def fetch_ban_addresses(code_insee: str, use_cache: bool = True) -> list[dict]:
    """Télécharge et parse l'export CSV complet de la BAN pour une commune.

    Chaque entrée retournée:
      id, numero, rep, nom_voie, lieu_dit, lat, lon, label
    `lieu_dit` est le hameau/lieu-dit quand l'adresse n'est pas rattachée au
    bourg par une voie nommée (champ BAN `lieudit_complement_nom`).
    """
    cache_name = f"ban-{code_insee}.json"
    if use_cache:
        cached = read_cache(cache_name)
        if cached is not None:
            return cached

    resp = _download_ban_csv(code_insee)
    raw = gzip.decompress(resp.content)
    text = raw.decode("utf-8")
    reader = csv.DictReader(io.StringIO(text), delimiter=";")

    addresses = []
    for row in reader:
        try:
            lat = float(row["lat"])
            lon = float(row["lon"])
        except (ValueError, KeyError, TypeError):
            continue
        if row.get("type") == "lieu-dit" and not row.get("numero"):
            # Lieu-dit sans numéro = pas une adresse postale distribuable
            continue
        addresses.append(
            {
                "id": row.get("id") or f"{code_insee}-{row.get('numero','')}-{row.get('nom_voie','')}",
                "numero": row.get("numero", "").strip(),
                "rep": row.get("rep", "").strip(),
                "nom_voie": (row.get("nom_voie") or "").strip(),
                "lieu_dit": (row.get("lieudit_complement_nom") or "").strip(),
                "code_postal": row.get("code_postal", "").strip(),
                "lat": lat,
                "lon": lon,
            }
        )

    write_cache(cache_name, addresses)
    return addresses


if __name__ == "__main__":
    import sys

    code = sys.argv[1] if len(sys.argv) > 1 else "69089"
    data = fetch_ban_addresses(code)
    print(f"{len(data)} adresses récupérées pour {code}")
    for a in data[:5]:
        print(a)
