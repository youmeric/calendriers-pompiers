"""Plateforme multi-casernes : chaque caserne a sa propre base SQLite et son propre dossier de données
(communes, sauvegardes). Une petite base « plateforme » liste les casernes et les adresses (noms d'hôte)
qui y mènent.

Mode multi-casernes actif seulement si PLATFORM_DB_PATH est défini. Sinon le site fonctionne comme
avant : une seule caserne, base DB_PATH, données SECTORS_DATA_DIR (installation actuelle de Courzieu).
"""
from __future__ import annotations

import contextvars
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timezone

PLATFORM_DB_PATH = os.environ.get("PLATFORM_DB_PATH") or ""
CASERNES_DIR = os.environ.get("CASERNES_DIR") or os.path.join(os.path.dirname(PLATFORM_DB_PATH) or ".", "casernes")
# domaine de la plateforme : « courzieu.<domaine> » mène à la caserne « courzieu » sans réglage de plus
PLATFORM_DOMAIN = (os.environ.get("PLATFORM_DOMAIN") or "").lower().strip(".")
# nom de la plateforme (marque), affiché discrètement sur les sites des casernes
PLATFORM_NAME = os.environ.get("PLATFORM_NAME") or "Almaneo"
# site vitrine (almaneo.fr) : contact et éditeur affichés en bas de page
PLATFORM_CONTACT_EMAIL = os.environ.get("PLATFORM_CONTACT_EMAIL") or ""
PLATFORM_EDITEUR = os.environ.get("PLATFORM_EDITEUR") or ""

SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
RESERVED = {"admin", "www", "api", "plateforme", "static", "mail"}
STATUTS = ("active", "suspendue", "archivee")
ABONNEMENTS = ("gratuit", "essai", "actif", "expire")


def enabled() -> bool:
    return bool(PLATFORM_DB_PATH)


@dataclass(frozen=True)
class Caserne:
    id: int
    slug: str
    nom: str
    statut: str
    abonnement: str
    abonnement_fin: str | None

    @property
    def dir(self) -> str:
        return os.path.join(CASERNES_DIR, self.slug)

    @property
    def db_path(self) -> str:
        return os.path.join(self.dir, "db", "status.db")

    @property
    def data_dir(self) -> str:
        return os.path.join(self.dir, "sectors")


# caserne de la requête (ou de la tâche de fond) en cours ; None = installation simple ou admin central
current: contextvars.ContextVar[Caserne | None] = contextvars.ContextVar("caserne", default=None)


@contextmanager
def use(caserne: Caserne | None):
    """Exécute un bloc « dans » une caserne (tâches de fond, création, tests)."""
    token = current.set(caserne)
    try:
        yield caserne
    finally:
        current.reset(token)


# ---- Base de la plateforme --------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def conn():
    os.makedirs(os.path.dirname(PLATFORM_DB_PATH) or ".", exist_ok=True)
    c = sqlite3.connect(PLATFORM_DB_PATH)
    try:
        yield c
    finally:
        c.close()


def init() -> None:
    if not enabled():
        return
    with conn() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS casernes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT NOT NULL UNIQUE,
                nom TEXT NOT NULL,
                statut TEXT NOT NULL DEFAULT 'active',
                -- option abonnement (sans effet tant que « abonnements_actifs » est désactivé)
                abonnement TEXT NOT NULL DEFAULT 'gratuit',
                abonnement_fin TEXT,
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            -- noms d'hôte menant à une caserne (sous-domaine, domaine propre…)
            CREATE TABLE IF NOT EXISTS caserne_hosts (
                host TEXT PRIMARY KEY,
                caserne_id INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reglages (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS journal (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at TEXT NOT NULL, qui TEXT NOT NULL, action TEXT NOT NULL, objet TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT ''
            );
            -- comptes nominatifs de l'admin central (en plus du compte principal PLATFORM_ADMIN_PASSWORD)
            CREATE TABLE IF NOT EXISTS comptes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                identifiant TEXT NOT NULL UNIQUE,
                nom TEXT NOT NULL,
                mdp TEXT NOT NULL,
                actif INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            -- demandes de démonstration envoyées depuis le site vitrine
            CREATE TABLE IF NOT EXISTS demandes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nom TEXT NOT NULL, caserne TEXT NOT NULL, email TEXT NOT NULL, telephone TEXT NOT NULL DEFAULT '',
                message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, traitee INTEGER NOT NULL DEFAULT 0
            );
            -- génération des données des communes (adresses, routes) d'une caserne
            CREATE TABLE IF NOT EXISTS generations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                caserne_id INTEGER NOT NULL,
                communes TEXT NOT NULL,
                statut TEXT NOT NULL,
                message TEXT NOT NULL DEFAULT '',
                started_at TEXT NOT NULL,
                ended_at TEXT
            );
        """)
        c.commit()


def _row(r) -> Caserne:
    return Caserne(id=r[0], slug=r[1], nom=r[2], statut=r[3], abonnement=r[4], abonnement_fin=r[5])


_COLS = "id, slug, nom, statut, abonnement, abonnement_fin"


def list_casernes() -> list[Caserne]:
    with conn() as c:
        return [_row(r) for r in c.execute(f"SELECT {_COLS} FROM casernes ORDER BY nom COLLATE NOCASE")]


def get(caserne_id: int) -> Caserne | None:
    with conn() as c:
        r = c.execute(f"SELECT {_COLS} FROM casernes WHERE id = ?", (caserne_id,)).fetchone()
    return _row(r) if r else None


def get_by_slug(slug: str) -> Caserne | None:
    with conn() as c:
        r = c.execute(f"SELECT {_COLS} FROM casernes WHERE slug = ?", (slug,)).fetchone()
    return _row(r) if r else None


def hosts(caserne_id: int) -> list[str]:
    with conn() as c:
        return [r[0] for r in c.execute("SELECT host FROM caserne_hosts WHERE caserne_id = ? ORDER BY host", (caserne_id,))]


def clean_host(host: str) -> str:
    host = (host or "").strip().lower()
    host = host.split("://")[-1].split("/")[0]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def resolve(host: str) -> Caserne | None:
    """Caserne correspondant au nom d'hôte de la requête (adresse enregistrée, ou <slug>.<domaine>)."""
    host = clean_host(host)
    with conn() as c:
        r = c.execute(f"SELECT {', '.join('c.' + x.strip() for x in _COLS.split(','))} FROM caserne_hosts h "
                      "JOIN casernes c ON c.id = h.caserne_id WHERE h.host = ?", (host,)).fetchone()
    if r:
        return _row(r)
    if PLATFORM_DOMAIN and host.endswith("." + PLATFORM_DOMAIN):
        sub = host[: -len(PLATFORM_DOMAIN) - 1]
        if "." not in sub:
            return get_by_slug(sub)
    return None


def vitrine_host(host: str) -> bool:
    """Le site vitrine : le domaine de la plateforme lui-même (almaneo.fr) et www.almaneo.fr."""
    host = clean_host(host)
    return bool(PLATFORM_DOMAIN) and host in (PLATFORM_DOMAIN, f"www.{PLATFORM_DOMAIN}")


def admin_host(host: str) -> bool:
    """Adresse de l'admin central : admin.<domaine>, ou toute adresse qui ne mène à aucune caserne."""
    host = clean_host(host)
    return (PLATFORM_DOMAIN and host == f"admin.{PLATFORM_DOMAIN}") or resolve(host) is None


def create(slug: str, nom: str, host_list: list[str]) -> Caserne:
    with conn() as c:
        cid = c.execute("INSERT INTO casernes (slug, nom, created_at) VALUES (?, ?, ?)", (slug, nom, _now())).lastrowid
        for h in host_list:
            c.execute("INSERT INTO caserne_hosts (host, caserne_id) VALUES (?, ?)", (clean_host(h), cid))
        c.commit()
    cas = get(cid)
    os.makedirs(os.path.join(cas.dir, "db"), exist_ok=True)
    os.makedirs(cas.data_dir, exist_ok=True)
    return cas


def update(caserne_id: int, **fields) -> Caserne:
    allowed = {"nom", "statut", "abonnement", "abonnement_fin", "note"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    with conn() as c:
        if sets:
            c.execute(f"UPDATE casernes SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", (*sets.values(), caserne_id))
        if "hosts" in fields and fields["hosts"] is not None:
            c.execute("DELETE FROM caserne_hosts WHERE caserne_id = ?", (caserne_id,))
            for h in fields["hosts"]:
                c.execute("INSERT INTO caserne_hosts (host, caserne_id) VALUES (?, ?)", (clean_host(h), caserne_id))
        c.commit()
    return get(caserne_id)


def host_owner(host: str) -> int | None:
    with conn() as c:
        r = c.execute("SELECT caserne_id FROM caserne_hosts WHERE host = ?", (clean_host(host),)).fetchone()
    return r[0] if r else None


def get_reglage(key: str, default: str = "") -> str:
    with conn() as c:
        r = c.execute("SELECT value FROM reglages WHERE key = ?", (key,)).fetchone()
    return r[0] if r else default


def set_reglage(key: str, value: str) -> None:
    with conn() as c:
        c.execute("INSERT INTO reglages (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))
        c.commit()


def log(qui: str, action: str, objet: str = "", details: str = "") -> None:
    with conn() as c:
        c.execute("INSERT INTO journal (at, qui, action, objet, details) VALUES (?, ?, ?, ?, ?)",
                  (_now(), qui[:80], action, objet[:200], details[:500]))
        c.commit()


def journal(limit: int = 200) -> list[dict]:
    with conn() as c:
        rows = c.execute("SELECT id, at, qui, action, objet, details FROM journal ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(zip(("id", "at", "qui", "action", "objet", "details"), r)) for r in rows]


# ---- Comptes de l'admin central ------------------------------------------------------------

_COMPTE = "id, identifiant, nom, mdp, actif, created_at"


def _compte(r) -> dict:
    return {"id": r[0], "identifiant": r[1], "nom": r[2], "mdp": r[3], "actif": bool(r[4]), "created_at": r[5]}


def list_comptes() -> list[dict]:
    with conn() as c:
        return [{k: v for k, v in _compte(r).items() if k != "mdp"} for r in c.execute(f"SELECT {_COMPTE} FROM comptes ORDER BY nom COLLATE NOCASE")]


def get_compte(compte_id: int) -> dict | None:
    with conn() as c:
        r = c.execute(f"SELECT {_COMPTE} FROM comptes WHERE id = ?", (compte_id,)).fetchone()
    return _compte(r) if r else None


def compte_par_identifiant(identifiant: str) -> dict | None:
    with conn() as c:
        r = c.execute(f"SELECT {_COMPTE} FROM comptes WHERE identifiant = ?", (identifiant.strip(),)).fetchone()
    return _compte(r) if r else None


def add_compte(identifiant: str, nom: str, mdp_hash: str) -> dict:
    with conn() as c:
        cid = c.execute("INSERT INTO comptes (identifiant, nom, mdp, created_at) VALUES (?, ?, ?, ?)",
                        (identifiant.strip(), nom.strip(), mdp_hash, _now())).lastrowid
        c.commit()
    return get_compte(cid)


def update_compte(compte_id: int, **fields) -> dict | None:
    sets = {k: (int(v) if k == "actif" else v) for k, v in fields.items() if k in ("nom", "mdp", "actif") and v is not None}
    if sets:
        with conn() as c:
            c.execute(f"UPDATE comptes SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", (*sets.values(), compte_id))
            c.commit()
    return get_compte(compte_id)


def delete_caserne(caserne_id: int) -> None:
    """Retire une caserne de la plateforme (ses fichiers sont effacés à part)."""
    with conn() as c:
        c.execute("DELETE FROM caserne_hosts WHERE caserne_id = ?", (caserne_id,))
        c.execute("DELETE FROM generations WHERE caserne_id = ?", (caserne_id,))
        c.execute("DELETE FROM casernes WHERE id = ?", (caserne_id,))
        c.commit()


# ---- Demandes de démonstration (site vitrine) ---------------------------------------------

_DEMANDE = ("id", "nom", "caserne", "email", "telephone", "message", "created_at", "traitee")


def add_demande(d: dict) -> int:
    with conn() as c:
        did = c.execute("INSERT INTO demandes (nom, caserne, email, telephone, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (d["nom"], d["caserne"], d["email"], d.get("telephone", ""), d.get("message", ""), _now())).lastrowid
        c.commit()
    return did


def list_demandes() -> list[dict]:
    with conn() as c:
        rows = c.execute(f"SELECT {', '.join(_DEMANDE)} FROM demandes ORDER BY traitee, id DESC").fetchall()
    return [{**dict(zip(_DEMANDE, r)), "traitee": bool(r[7])} for r in rows]


def set_demande_traitee(demande_id: int, traitee: bool) -> bool:
    with conn() as c:
        n = c.execute("UPDATE demandes SET traitee = ? WHERE id = ?", (int(traitee), demande_id)).rowcount
        c.commit()
    return n > 0


# ---- Abonnement (option, désactivée par défaut) -------------------------------------------

def abonnements_actifs() -> bool:
    return enabled() and get_reglage("abonnements_actifs", "0") == "1"


def abonnement_etat(cas: Caserne) -> dict:
    """État de l'abonnement d'une caserne. Sans effet tant que l'option n'est pas activée dans l'admin central."""
    if not abonnements_actifs() or cas.abonnement == "gratuit":
        return {"actif": True, "option": abonnements_actifs(), "formule": cas.abonnement, "fin": cas.abonnement_fin, "jours_restants": None}
    fin = cas.abonnement_fin
    reste = (date.fromisoformat(fin) - date.today()).days if fin else None
    ok = cas.abonnement in ("essai", "actif") and (reste is None or reste >= 0)
    return {"actif": ok, "option": True, "formule": cas.abonnement, "fin": fin, "jours_restants": reste}


# ---- Générations des données des communes ------------------------------------------------

def add_generation(caserne_id: int, communes: list[dict]) -> int:
    with conn() as c:
        gid = c.execute("INSERT INTO generations (caserne_id, communes, statut, started_at) VALUES (?, ?, 'en_cours', ?)",
                        (caserne_id, json.dumps(communes, ensure_ascii=False), _now())).lastrowid
        c.commit()
    return gid


def end_generation(gid: int, ok: bool, message: str) -> None:
    with conn() as c:
        c.execute("UPDATE generations SET statut = ?, message = ?, ended_at = ? WHERE id = ?",
                  ("ok" if ok else "echec", message[-2000:], _now(), gid))
        c.commit()


def last_generation(caserne_id: int) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT id, communes, statut, message, started_at, ended_at FROM generations WHERE caserne_id = ? "
                      "ORDER BY id DESC LIMIT 1", (caserne_id,)).fetchone()
    if not r:
        return None
    return {"id": r[0], "communes": json.loads(r[1]), "statut": r[2], "message": r[3], "started_at": r[4], "ended_at": r[5]}
