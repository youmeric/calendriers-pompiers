"""Récupération des adresses officielles depuis la Base Adresse Nationale (BAN).

La BAN publie un export CSV complet **par département** (pas par commune) :
https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-{dept}.csv.gz
On télécharge donc le fichier du département une seule fois (mis en cache sur
disque), puis on filtre les lignes de la/des commune(s) voulues.
"""
from __future__ import annotations

import csv
import gzip

from common import cache_path, http_get, read_cache, write_cache

BAN_CSV_URL = "https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-{dept}.csv.gz"


def department_code(code_insee: str) -> str:
    """Déduit le code département (2 chiffres, 2A/2B pour la Corse, 3 chiffres
    pour les DOM) à partir d'un code INSEE commune."""
    if code_insee[:2] == "97" or code_insee[:2] == "98":
        return code_insee[:3]
    return code_insee[:2]


_downloaded_this_run: set[str] = set()


def _download_department_csv(dept: str, use_cache: bool) -> "Path":
    """Télécharge (ou réutilise) le fichier CSV.gz du département et renvoie
    son chemin local. Sans cache, il n'est retéléchargé qu'une fois par
    exécution même si plusieurs communes sont dans le même département."""
    gz_path = cache_path(f"ban-dept-{dept}.csv.gz")
    fresh_needed = not use_cache and dept not in _downloaded_this_run
    if fresh_needed or not gz_path.exists():
        _downloaded_this_run.add(dept)
        url = BAN_CSV_URL.format(dept=dept)
        resp = http_get(url, timeout=300)
        tmp_path = gz_path.with_suffix(".tmp")
        with open(tmp_path, "wb") as fh:
            fh.write(resp.content)
        tmp_path.replace(gz_path)
    return gz_path


def _parse_rows(gz_path, code_insee_filter: set[str]):
    with gzip.open(gz_path, "rt", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh, delimiter=";")
        for row in reader:
            if row.get("code_insee") in code_insee_filter:
                yield row


def fetch_ban_addresses(code_insee: str, use_cache: bool = True) -> list[dict]:
    """Télécharge (si besoin) le CSV départemental et retourne les adresses
    de la commune `code_insee`.

    Chaque entrée retournée:
      id, numero, rep, nom_voie, lieu_dit, lat, lon
    `lieu_dit` est le hameau/lieu-dit quand l'adresse n'est pas rattachée au
    bourg par une voie nommée (champ BAN `lieudit_complement_nom`).
    """
    cache_name = f"ban-{code_insee}.json"
    if use_cache:
        cached = read_cache(cache_name)
        if cached is not None:
            return cached

    dept = department_code(code_insee)
    gz_path = _download_department_csv(dept, use_cache)

    addresses = []
    for row in _parse_rows(gz_path, {code_insee}):
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

    if not addresses:
        raise RuntimeError(
            f"Aucune adresse trouvée pour le code INSEE {code_insee} dans le fichier "
            f"départemental {dept}. Vérifiez que le code INSEE est correct, ou que la "
            f"colonne 'code_insee' du CSV BAN n'a pas changé de nom."
        )

    write_cache(cache_name, addresses)
    return addresses


if __name__ == "__main__":
    import sys

    code = sys.argv[1] if len(sys.argv) > 1 else "69067"
    data = fetch_ban_addresses(code)
    print(f"{len(data)} adresses récupérées pour {code}")
    for a in data[:5]:
        print(a)
