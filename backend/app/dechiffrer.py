"""Déchiffre une sauvegarde copiée hors du serveur :

    docker compose exec backend python -m app.dechiffrer /app/db/calendriers-2026-11-08_0300.db.chiffre

La phrase secrète est demandée au clavier ; le fichier .db obtenu se restaure comme une sauvegarde
normale (voir README, « Restaurer une sauvegarde »)."""
from __future__ import annotations

import getpass
import sys

from .offsite import decrypt


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    src = sys.argv[1]
    dst = src[: -len(".chiffre")] if src.endswith(".chiffre") else src + ".db"
    with open(src, "rb") as fh:
        blob = fh.read()
    try:
        data = decrypt(blob, getpass.getpass("Phrase secrète : "))
    except ValueError as err:
        print(f"Échec : {err}")
        return 1
    with open(dst, "wb") as fh:
        fh.write(data)
    print(f"Sauvegarde déchiffrée : {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
