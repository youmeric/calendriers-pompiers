"""Bascule d'une installation simple (une seule caserne) vers la plateforme Almaneo.

La base et les communes de l'installation deviennent une caserne de la plateforme, avec toutes leurs
données (secteurs, équipes et codes d'accès, suivi, dons, registre, caisse, journal, réglages,
sauvegardes). La base d'origine n'est jamais modifiée : on n'en fait qu'une copie cohérente, donc le
retour arrière consiste simplement à relancer le site sans PLATFORM_DB_PATH.

Dans le conteneur (variables PLATFORM_* réglées dans .env) :

    python -m app.basculer --slug courzieu --adresse spcourzieu.fr \\
        --admin-identifiant chef.courzieu --admin-nom "Prénom Nom" --essai
    (puis la même commande sans --essai)
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import os
import shutil
import sqlite3
import sys
from pathlib import Path

from . import auth, db, plateforme

COUNTS = {
    "secteurs": "SELECT COUNT(*) FROM sectors",
    "personnes (codes d'accès)": "SELECT COUNT(*) FROM personnes",
    "membres d'équipes": "SELECT COUNT(*) FROM sector_team",
    "statuts des maisons": "SELECT COUNT(*) FROM address_status",
    "dons (registre)": "SELECT COUNT(*) FROM dons",
    "remises de caisse": "SELECT COUNT(*) FROM remises",
    "comptes de la console": "SELECT COUNT(*) FROM comptes",
    "lignes de journal": "SELECT COUNT(*) FROM journal",
}


def _counts(path: str) -> dict[str, int]:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        out = {}
        for label, sql in COUNTS.items():
            try:
                out[label] = conn.execute(sql).fetchone()[0]
            except sqlite3.OperationalError:
                out[label] = 0
        return out
    finally:
        conn.close()


def _setting(path: str, key: str) -> str:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row[0] if row else ""
    except sqlite3.OperationalError:
        return ""
    finally:
        conn.close()


def _has_account(path: str, identifiant: str) -> bool:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return bool(conn.execute("SELECT 1 FROM comptes WHERE identifiant = ?", (identifiant,)).fetchone())
    except sqlite3.OperationalError:
        return False
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    here = Path(__file__).resolve()
    default_logo = next((p for p in (here.parent.parent / "frontend" / "img" / "logo-courzieu.png",
                                     here.parents[2] / "frontend" / "img" / "logo-courzieu.png") if p.exists()), None)
    ap = argparse.ArgumentParser(description="Fait de l'installation actuelle une caserne de la plateforme Almaneo.")
    ap.add_argument("--source-db", default=os.environ.get("DB_PATH", "/app/db/status.db"), help="base de l'installation actuelle")
    ap.add_argument("--source-data", default=os.environ.get("SECTORS_DATA_DIR", "/app/sectors"), help="dossier des communes")
    ap.add_argument("--slug", default="courzieu", help="identifiant de la caserne (courzieu → courzieu.<domaine>)")
    ap.add_argument("--nom", default="", help="nom affiché (par défaut : celui de l'installation, sinon « Sapeurs-pompiers de Courzieu »)")
    ap.add_argument("--adresse", action="append", default=[], help="adresse propre à la caserne, ex. spcourzieu.fr (répétable)")
    ap.add_argument("--admin-identifiant", default="", help="compte nominatif à créer pour remplacer le compte principal")
    ap.add_argument("--admin-nom", default="Administrateur")
    ap.add_argument("--admin-mot-de-passe", default=os.environ.get("ADMIN_PASSWORD", ""),
                    help="mot de passe de ce compte (par défaut : ADMIN_PASSWORD actuel)")
    ap.add_argument("--logo", default=str(default_logo or ""), help="logo de la caserne (par défaut : l'écusson de Courzieu)")
    ap.add_argument("--essai", action="store_true", help="vérifier sans rien écrire")
    a = ap.parse_args(argv)

    say = print
    if not plateforme.enabled():
        say("✕ PLATFORM_DB_PATH n'est pas réglé : réglez les variables PLATFORM_* (voir docs/MISE-EN-SERVICE.md).")
        return 2
    if not os.path.exists(a.source_db):
        say(f"✕ Base introuvable : {a.source_db}")
        return 2
    plateforme.init()
    slug = a.slug.strip().lower()
    if not plateforme.SLUG_RE.match(slug) or slug in plateforme.RESERVED:
        say(f"✕ Identifiant de caserne invalide : {slug}")
        return 2
    if plateforme.get_by_slug(slug):
        say(f"✕ La caserne « {slug} » existe déjà sur la plateforme : rien n'est fait.")
        return 2
    hosts = [plateforme.clean_host(h) for h in a.adresse if plateforme.clean_host(h)]
    for h in hosts:
        if plateforme.host_owner(h) is not None:
            say(f"✕ L'adresse {h} mène déjà à une autre caserne.")
            return 2
    ident = a.admin_identifiant.strip()
    if ident and not _has_account(a.source_db, ident) and len(a.admin_mot_de_passe) < 8:
        say("✕ Mot de passe du compte administrateur : 8 caractères au moins (ou ADMIN_PASSWORD).")
        return 2
    nom = a.nom.strip() or _setting(a.source_db, "caserne_nom") or "Sapeurs-pompiers de Courzieu"
    before = _counts(a.source_db)
    communes = sorted(p.name for p in Path(a.source_data).glob("*.json")) if os.path.isdir(a.source_data) else []

    say(f"Bascule de {a.source_db} vers la caserne « {nom} » ({slug})")
    say(f"  adresses : {', '.join(hosts) or '—'}" + (f" + {slug}.{plateforme.PLATFORM_DOMAIN}" if plateforme.PLATFORM_DOMAIN else ""))
    say(f"  communes : {', '.join(communes) or 'aucune'}")
    for k, v in before.items():
        say(f"  {k} : {v}")
    if ident:
        say(f"  compte administrateur : {ident}" + (" (existe déjà)" if _has_account(a.source_db, ident) else " (sera créé)"))
    else:
        say("  ⚠ pas de --admin-identifiant : le compte principal (ADMIN_PASSWORD) n'existe pas dans une caserne ;"
            " seuls les comptes nominatifs existants pourront se connecter à l'admin.")
    if a.essai:
        say("Essai : rien n'a été écrit.")
        return 0

    cas = plateforme.create(slug, nom, hosts)
    # copie cohérente de la base (l'originale n'est jamais modifiée)
    src = sqlite3.connect(f"file:{a.source_db}?mode=ro", uri=True)
    dest = sqlite3.connect(cas.db_path)
    try:
        src.backup(dest)
    finally:
        dest.close()
        src.close()
    for f in Path(a.source_data).glob("*") if os.path.isdir(a.source_data) else []:
        if f.is_file():
            shutil.copy2(f, Path(cas.data_dir) / f.name)
    old_backups = Path(os.environ.get("BACKUP_DIR") or Path(a.source_db).parent / "sauvegardes")
    if old_backups.is_dir():  # l'historique des sauvegardes suit la caserne
        shutil.copytree(old_backups, Path(cas.db_path).parent / "sauvegardes", dirs_exist_ok=True)

    with plateforme.use(cas):
        db.init_db()  # mises à jour éventuelles de la base
        db.set_setting("caserne_nom", nom)
        db.set_setting("demarrage_fait", "1")  # caserne déjà en service : pas de guide de démarrage
        if os.environ.get("SECRET_KEY") and not _setting(a.source_db, "session_secret"):
            db.set_setting("session_secret", os.environ["SECRET_KEY"])  # mêmes sessions qu'avant
        if not db.get_setting("caserne_logo", "") and a.logo and os.path.exists(a.logo):
            raw = Path(a.logo).read_bytes()
            kind = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "svg": "image/svg+xml"}[a.logo.rsplit(".", 1)[-1].lower()]
            db.set_setting("caserne_logo", base64.b64encode(raw).decode())
            db.set_setting("caserne_logo_type", kind)
            db.set_setting("caserne_logo_v", hashlib.sha1(raw).hexdigest()[:10])
        if ident and not db.compte_login(ident):
            role = next(r for r in db.list_roles() if r["fixe"])
            db.add_compte(ident, a.admin_nom.strip() or ident, auth.hash_password(a.admin_mot_de_passe), role["id"])
        db.log("Bascule", "console", "plateforme.bascule", nom, f"installation basculée vers la plateforme ({slug})")
    after = _counts(cas.db_path)
    plateforme.log("bascule", "caserne.bascule", nom, f"{slug} · " + ", ".join(f"{k} {v}" for k, v in before.items()))

    diff = {k: (before[k], after[k]) for k in before if after[k] < before[k]}
    if diff:
        say("✕ Données manquantes après la copie : " + ", ".join(f"{k} {b} → {c}" for k, (b, c) in diff.items()))
        return 1
    say("✓ Bascule faite : toutes les données sont dans la caserne. Base d'origine intacte : " + a.source_db)
    return 0


if __name__ == "__main__":
    sys.exit(main())
