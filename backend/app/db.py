"""Accès SQLite : secteurs dessinés par l'admin et statut de chaque adresse."""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from .geo import normalize_polys

DB_PATH = os.environ.get("DB_PATH", "db/status.db")

VALID_STATUSES = {"fait", "absent", "refus"}


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS address_status (
                commune_slug TEXT NOT NULL,
                address_id TEXT NOT NULL,
                status TEXT,
                note TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (commune_slug, address_id)
            );
            CREATE TABLE IF NOT EXISTS sectors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                commune_slug TEXT NOT NULL,
                position INTEGER NOT NULL,
                nom TEXT NOT NULL,
                couleur TEXT NOT NULL,
                polygon TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sectors_commune ON sectors (commune_slug, position);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sector_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                commune_slug TEXT NOT NULL,
                saved_at TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS versions_commune ON sector_versions (commune_slug, id);
            CREATE TABLE IF NOT EXISTS excluded_addresses (
                commune_slug TEXT NOT NULL,
                address_id TEXT NOT NULL,
                excluded_at TEXT NOT NULL,
                PRIMARY KEY (commune_slug, address_id)
            );
            -- membres de la caserne qui participent à la tournée
            CREATE TABLE IF NOT EXISTS personnes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nom TEXT NOT NULL,
                telephone TEXT NOT NULL DEFAULT ''
            );
            -- qui fait quel secteur : responsable(s) puis équipiers, dans l'ordre
            CREATE TABLE IF NOT EXISTS sector_team (
                sector_id INTEGER NOT NULL,
                personne_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY (sector_id, personne_id)
            );
            -- dons reçus pendant la tournée (montant en centimes)
            CREATE TABLE IF NOT EXISTS dons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                annee INTEGER NOT NULL,
                commune_slug TEXT NOT NULL,
                address_id TEXT NOT NULL,
                sector_id INTEGER NOT NULL,
                montant_cents INTEGER NOT NULL,
                mode TEXT NOT NULL,
                statut TEXT NOT NULL,
                foreign_id TEXT UNIQUE,
                tx_code TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                personne_id INTEGER,
                personne_nom TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS dons_sector ON dons (annee, sector_id);
            -- caisse remise par le responsable d'un secteur au trésorier
            CREATE TABLE IF NOT EXISTS remises (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                annee INTEGER NOT NULL,
                sector_id INTEGER NOT NULL,
                especes_cents INTEGER NOT NULL,
                cheques_cents INTEGER NOT NULL,
                nb_cheques INTEGER NOT NULL,
                attendu_especes_cents INTEGER NOT NULL,
                attendu_cheques_cents INTEGER NOT NULL,
                remis_par TEXT NOT NULL,
                recu_par TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                confirme_le TEXT
            );
            -- organisation du secteur : date, créneau, avancement, consignes
            CREATE TABLE IF NOT EXISTS sector_plan (
                sector_id INTEGER PRIMARY KEY,
                date TEXT NOT NULL DEFAULT '',
                creneau TEXT NOT NULL DEFAULT '',
                statut TEXT NOT NULL DEFAULT 'a_faire',
                note TEXT NOT NULL DEFAULT ''
            );
            """
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(sectors)")}
        if "limite" not in columns:
            conn.execute("ALTER TABLE sectors ADD COLUMN limite TEXT")
        if "limite_src" not in columns:
            conn.execute("ALTER TABLE sectors ADD COLUMN limite_src TEXT")
        # statuts par année de tournée (avant : une seule année, sans colonne)
        scols = {row[1] for row in conn.execute("PRAGMA table_info(address_status)")}
        if "annee" not in scols:
            annee = _current_annee(conn)
            conn.executescript(f"""
                CREATE TABLE address_status_new (
                    commune_slug TEXT NOT NULL,
                    address_id TEXT NOT NULL,
                    annee INTEGER NOT NULL,
                    status TEXT,
                    note TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (commune_slug, address_id, annee)
                );
                INSERT INTO address_status_new (commune_slug, address_id, annee, status, note, updated_at)
                    SELECT commune_slug, address_id, {int(annee)}, status, note, updated_at FROM address_status;
                DROP TABLE address_status;
                ALTER TABLE address_status_new RENAME TO address_status;
            """)
        # code d'accès personnel des équipes (ajouté après coup : on complète les anciennes fiches)
        pcols = {row[1] for row in conn.execute("PRAGMA table_info(personnes)")}
        if "code" not in pcols:
            conn.execute("ALTER TABLE personnes ADD COLUMN code TEXT")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS personnes_code ON personnes (code)")
        for (pid,) in conn.execute("SELECT id FROM personnes WHERE code IS NULL OR code = ''").fetchall():
            conn.execute("UPDATE personnes SET code = ? WHERE id = ?", (_new_code(conn), pid))
        conn.commit()


CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # sans 0/O ni 1/I : se dicte sans erreur
CODE_LENGTH = 8


def _new_code(conn) -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        if not conn.execute("SELECT 1 FROM personnes WHERE code = ?", (code,)).fetchone():
            return code


def _current_annee(conn) -> int:
    row = conn.execute("SELECT value FROM settings WHERE key = 'annee'").fetchone()
    if row and str(row[0]).isdigit():
        return int(row[0])
    today = datetime.now().date()
    return today.year + 1 if today.month >= 7 else today.year


def current_annee() -> int:
    """Année de la tournée : réglée dans l'admin, sinon celle des calendriers distribués
    à cette saison (à partir de juillet, ceux de l'année suivante)."""
    with get_conn() as conn:
        return _current_annee(conn)


def normalize_code(raw: str) -> str:
    return "".join(ch for ch in raw.upper() if ch in CODE_ALPHABET)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- Réglages ----------------------------------------------------------------

def get_or_create_secret() -> str:
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'session_secret'").fetchone()
        if row:
            return row[0]
        value = secrets.token_hex(32)
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_secret', ?)", (value,))
        conn.commit()
        return conn.execute("SELECT value FROM settings WHERE key = 'session_secret'").fetchone()[0]


def get_setting(key: str, default: str | None = None) -> str | None:
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def set_setting(key: str, value: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        conn.commit()


# ---- Secteurs ----------------------------------------------------------------

MAX_VERSIONS = 30


def list_sectors(commune_slug: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, nom, couleur, polygon, limite, limite_src FROM sectors "
            "WHERE commune_slug = ? ORDER BY position, id",
            (commune_slug,),
        ).fetchall()
    return [
        {"id": r[0], "nom": r[1], "couleur": r[2], "polygon": normalize_polys(json.loads(r[3])),
         "limite": json.loads(r[4]) if r[4] else None, "limite_src": r[5]}
        for r in rows
    ]


def set_sector_limite(sector_id: int, limite: list[dict], src: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE sectors SET limite = ?, limite_src = ? WHERE id = ?",
                     (json.dumps(limite, ensure_ascii=False), src, sector_id))
        conn.commit()


def replace_sectors(commune_slug: str, sectors: list[dict]) -> list[dict]:
    """Remplace les secteurs d'une commune. Les secteurs envoyés avec un `id`
    existant sont mis à jour (leur id, donc leur lien partagé, reste stable)."""
    now = _now()
    with get_conn() as conn:
        existing = {r[0] for r in conn.execute(
            "SELECT id FROM sectors WHERE commune_slug = ?", (commune_slug,)).fetchall()}
        kept = set()
        for position, s in enumerate(sectors):
            polygon = json.dumps(s["polygon"])
            if s.get("id") in existing:
                # limite_src remis à zéro : la description sera recalculée
                conn.execute(
                    "UPDATE sectors SET position = ?, nom = ?, couleur = ?, polygon = ?, updated_at = ?, "
                    "limite_src = NULL WHERE id = ?",
                    (position, s["nom"], s["couleur"], polygon, now, s["id"]),
                )
                kept.add(s["id"])
            else:
                conn.execute(
                    "INSERT INTO sectors (commune_slug, position, nom, couleur, polygon, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (commune_slug, position, s["nom"], s["couleur"], polygon, now),
                )
        for sector_id in existing - kept:
            conn.execute("DELETE FROM sectors WHERE id = ?", (sector_id,))
            conn.execute("DELETE FROM sector_team WHERE sector_id = ?", (sector_id,))
            conn.execute("DELETE FROM sector_plan WHERE sector_id = ?", (sector_id,))
        conn.commit()
    saved = list_sectors(commune_slug)
    _add_version(commune_slug, saved, now)
    return saved


def _add_version(commune_slug: str, sectors: list[dict], now: str) -> None:
    snapshot = [{k: s[k] for k in ("id", "nom", "couleur", "polygon")} for s in sectors]
    with get_conn() as conn:
        conn.execute("INSERT INTO sector_versions (commune_slug, saved_at, data) VALUES (?, ?, ?)",
                     (commune_slug, now, json.dumps(snapshot, ensure_ascii=False)))
        conn.execute(
            "DELETE FROM sector_versions WHERE commune_slug = ? AND id NOT IN "
            "(SELECT id FROM sector_versions WHERE commune_slug = ? ORDER BY id DESC LIMIT ?)",
            (commune_slug, commune_slug, MAX_VERSIONS),
        )
        conn.commit()


def list_versions(commune_slug: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, saved_at, data FROM sector_versions WHERE commune_slug = ? ORDER BY id DESC",
            (commune_slug,),
        ).fetchall()
    out = []
    for vid, saved_at, data in rows:
        sectors = json.loads(data)
        out.append({"id": vid, "saved_at": saved_at, "nb": len(sectors), "noms": [s["nom"] for s in sectors]})
    return out


def get_version(commune_slug: str, version_id: int) -> list[dict] | None:
    with get_conn() as conn:
        row = conn.execute("SELECT data FROM sector_versions WHERE commune_slug = ? AND id = ?",
                           (commune_slug, version_id)).fetchone()
    if not row:
        return None
    sectors = json.loads(row[0])
    for s in sectors:
        s["polygon"] = normalize_polys(s["polygon"])
    return sectors


# ---- Adresses exclues (cimetière, bâtiment sans habitant…) ---------------------

def get_excluded(commune_slug: str) -> set[str]:
    with get_conn() as conn:
        rows = conn.execute("SELECT address_id FROM excluded_addresses WHERE commune_slug = ?",
                            (commune_slug,)).fetchall()
    return {r[0] for r in rows}


def set_excluded(commune_slug: str, address_ids: list[str], excluded: bool) -> None:
    now = _now()
    with get_conn() as conn:
        if excluded:
            conn.executemany(
                "INSERT OR IGNORE INTO excluded_addresses (commune_slug, address_id, excluded_at) VALUES (?, ?, ?)",
                [(commune_slug, a, now) for a in address_ids],
            )
        else:
            conn.executemany(
                "DELETE FROM excluded_addresses WHERE commune_slug = ? AND address_id = ?",
                [(commune_slug, a) for a in address_ids],
            )
        conn.commit()


# ---- Statuts des adresses -----------------------------------------------------

def get_statuses(commune_slug: str, annee: int | None = None) -> dict[str, dict]:
    annee = annee or current_annee()
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT address_id, status, note, updated_at FROM address_status WHERE commune_slug = ? AND annee = ?",
            (commune_slug, annee),
        )
        return {row[0]: {"status": row[1], "note": row[2], "updated_at": row[3]} for row in cur.fetchall()}


def set_status(commune_slug: str, address_id: str, status: str | None, note: str | None) -> dict:
    if status is not None and status not in VALID_STATUSES:
        raise ValueError(f"statut invalide: {status}")
    now = _now()
    annee = current_annee()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO address_status (commune_slug, address_id, annee, status, note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(commune_slug, address_id, annee)
            DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at
            """,
            (commune_slug, address_id, annee, status, note, now),
        )
        conn.commit()
    return {"address_id": address_id, "status": status, "note": note, "updated_at": now}


def reset_statuses(commune_slug: str) -> None:
    """Efface les statuts de l'année en cours (les années passées restent pour l'historique)."""
    with get_conn() as conn:
        conn.execute("DELETE FROM address_status WHERE commune_slug = ? AND annee = ?",
                     (commune_slug, current_annee()))
        conn.commit()


def previous_year(commune_slug: str, annee: int) -> dict[str, dict]:
    """Ce qui s'est passé à chaque adresse lors de la dernière tournée avant `annee` :
    {address_id: {annee, status, montant_cents, nb_dons}}."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT MAX(a) FROM (SELECT MAX(annee) AS a FROM address_status WHERE commune_slug = ? AND annee < ? "
            "UNION SELECT MAX(annee) FROM dons WHERE commune_slug = ? AND annee < ?)",
            (commune_slug, annee, commune_slug, annee),
        ).fetchone()
        last = row[0] if row else None
        if not last:
            return {}
        out: dict[str, dict] = {}
        for aid, status in conn.execute(
                "SELECT address_id, status FROM address_status WHERE commune_slug = ? AND annee = ? AND status IS NOT NULL",
                (commune_slug, last)):
            out[aid] = {"annee": last, "status": status, "montant_cents": 0, "nb_dons": 0}
        for aid, total, nb in conn.execute(
                "SELECT address_id, SUM(montant_cents), COUNT(*) FROM dons WHERE commune_slug = ? AND annee = ? "
                "AND statut = 'ok' GROUP BY address_id", (commune_slug, last)):
            item = out.setdefault(aid, {"annee": last, "status": "fait", "montant_cents": 0, "nb_dons": 0})
            item["montant_cents"], item["nb_dons"] = total, nb
    return out


# ---- Équipes : personnes et organisation de chaque secteur ----------------------

ROLES = ("responsable", "equipier")
STATUTS = ("a_faire", "en_cours", "termine")


def list_personnes() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT id, nom, telephone, code FROM personnes ORDER BY nom COLLATE NOCASE, id").fetchall()
    return [{"id": r[0], "nom": r[1], "telephone": r[2], "code": r[3]} for r in rows]


def get_personne(personne_id: int) -> dict | None:
    with get_conn() as conn:
        r = conn.execute("SELECT id, nom, telephone, code FROM personnes WHERE id = ?", (personne_id,)).fetchone()
    return {"id": r[0], "nom": r[1], "telephone": r[2], "code": r[3]} if r else None


def get_personne_by_code(code: str) -> dict | None:
    code = normalize_code(code)
    if len(code) != CODE_LENGTH:
        return None
    with get_conn() as conn:
        r = conn.execute("SELECT id FROM personnes WHERE code = ?", (code,)).fetchone()
    return get_personne(r[0]) if r else None


def regenerate_code(personne_id: int) -> dict | None:
    with get_conn() as conn:
        cur = conn.execute("UPDATE personnes SET code = ? WHERE id = ?", (_new_code(conn), personne_id))
        conn.commit()
    return get_personne(personne_id) if cur.rowcount else None


def memberships(personne_id: int) -> dict[int, str]:
    """Secteurs d'une personne : {sector_id: rôle}."""
    with get_conn() as conn:
        rows = conn.execute("SELECT t.sector_id, t.role FROM sector_team t JOIN sectors s ON s.id = t.sector_id "
                            "WHERE t.personne_id = ?", (personne_id,)).fetchall()
    return {r[0]: r[1] for r in rows}


def add_personnes(items: list[dict]) -> list[dict]:
    with get_conn() as conn:
        ids = [
            conn.execute("INSERT INTO personnes (nom, telephone, code) VALUES (?, ?, ?)",
                         (p["nom"], p.get("telephone") or "", _new_code(conn))).lastrowid
            for p in items
        ]
        conn.commit()
    by_id = {p["id"]: p for p in list_personnes()}
    return [by_id[i] for i in ids]


def update_personne(personne_id: int, nom: str, telephone: str) -> dict | None:
    with get_conn() as conn:
        cur = conn.execute("UPDATE personnes SET nom = ?, telephone = ? WHERE id = ?", (nom, telephone, personne_id))
        conn.commit()
    return get_personne(personne_id) if cur.rowcount else None


def delete_personne(personne_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM personnes WHERE id = ?", (personne_id,))
        conn.execute("DELETE FROM sector_team WHERE personne_id = ?", (personne_id,))
        conn.commit()
    return bool(cur.rowcount)


def sector_communes() -> dict[str, set[int]]:
    """Secteurs par commune : {slug: {sector_id, ...}}."""
    out: dict[str, set[int]] = {}
    with get_conn() as conn:
        for slug, sid in conn.execute("SELECT commune_slug, id FROM sectors").fetchall():
            out.setdefault(slug, set()).add(sid)
    return out


def existing_sector_ids() -> set[int]:
    with get_conn() as conn:
        return {r[0] for r in conn.execute("SELECT id FROM sectors").fetchall()}


def get_teams() -> dict[int, dict]:
    """Organisation de chaque secteur : {sector_id: {date, creneau, statut, note, membres}}."""
    with get_conn() as conn:
        plans = conn.execute("SELECT sector_id, date, creneau, statut, note FROM sector_plan").fetchall()
        members = conn.execute(
            "SELECT t.sector_id, t.personne_id, t.role FROM sector_team t "
            "JOIN personnes p ON p.id = t.personne_id "
            "ORDER BY t.sector_id, CASE t.role WHEN 'responsable' THEN 0 ELSE 1 END, t.position"
        ).fetchall()
    teams: dict[int, dict] = {}

    def team(sector_id: int) -> dict:
        return teams.setdefault(sector_id, {"date": "", "creneau": "", "statut": "a_faire", "note": "", "membres": []})

    for sector_id, date, creneau, statut, note in plans:
        team(sector_id).update({"date": date, "creneau": creneau, "statut": statut, "note": note})
    for sector_id, personne_id, role in members:
        team(sector_id)["membres"].append({"personne_id": personne_id, "role": role})
    return teams


def set_team(sector_id: int, plan: dict, membres: list[dict]) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO sector_plan (sector_id, date, creneau, statut, note) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(sector_id) DO UPDATE SET date = excluded.date, creneau = excluded.creneau, "
            "statut = excluded.statut, note = excluded.note",
            (sector_id, plan["date"], plan["creneau"], plan["statut"], plan["note"]),
        )
        conn.execute("DELETE FROM sector_team WHERE sector_id = ?", (sector_id,))
        conn.executemany(
            "INSERT INTO sector_team (sector_id, personne_id, role, position) VALUES (?, ?, ?, ?)",
            [(sector_id, m["personne_id"], m["role"], i) for i, m in enumerate(membres)],
        )
        conn.commit()


# ---- Dons -------------------------------------------------------------------------

MODES = ("especes", "cheque", "cb")
DON_STATUTS = ("ok", "attente", "echec")
_DON_COLS = ("id", "annee", "commune_slug", "address_id", "sector_id", "montant_cents", "mode", "statut",
             "foreign_id", "tx_code", "note", "personne_id", "personne_nom", "created_at", "updated_at")


def _don(row) -> dict:
    return dict(zip(_DON_COLS, row))


def add_don(d: dict) -> dict:
    now = _now()
    with get_conn() as conn:
        did = conn.execute(
            "INSERT INTO dons (annee, commune_slug, address_id, sector_id, montant_cents, mode, statut, foreign_id, "
            "tx_code, note, personne_id, personne_nom, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (d["annee"], d["commune_slug"], d["address_id"], d["sector_id"], d["montant_cents"], d["mode"],
             d["statut"], d.get("foreign_id"), d.get("tx_code", ""), d.get("note", ""), d.get("personne_id"),
             d.get("personne_nom", ""), now, now),
        ).lastrowid
        conn.commit()
    return get_don(did)


def get_don(don_id: int) -> dict | None:
    with get_conn() as conn:
        r = conn.execute(f"SELECT {', '.join(_DON_COLS)} FROM dons WHERE id = ?", (don_id,)).fetchone()
    return _don(r) if r else None


def get_don_by_foreign(foreign_id: str) -> dict | None:
    with get_conn() as conn:
        r = conn.execute(f"SELECT {', '.join(_DON_COLS)} FROM dons WHERE foreign_id = ?", (foreign_id,)).fetchone()
    return _don(r) if r else None


def list_dons(annee: int, sector_id: int | None = None) -> list[dict]:
    sql = f"SELECT {', '.join(_DON_COLS)} FROM dons WHERE annee = ?"
    args: list = [annee]
    if sector_id is not None:
        sql += " AND sector_id = ?"
        args.append(sector_id)
    with get_conn() as conn:
        rows = conn.execute(sql + " ORDER BY id", args).fetchall()
    return [_don(r) for r in rows]


def set_don_statut(don_id: int, statut: str, tx_code: str | None = None) -> dict | None:
    with get_conn() as conn:
        if tx_code is None:
            conn.execute("UPDATE dons SET statut = ?, updated_at = ? WHERE id = ?", (statut, _now(), don_id))
        else:
            conn.execute("UPDATE dons SET statut = ?, tx_code = ?, updated_at = ? WHERE id = ?",
                         (statut, tx_code, _now(), don_id))
        conn.commit()
    return get_don(don_id)


def delete_don(don_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM dons WHERE id = ?", (don_id,))
        conn.commit()


# ---- Remises de caisse ------------------------------------------------------------

_REMISE_COLS = ("id", "annee", "sector_id", "especes_cents", "cheques_cents", "nb_cheques", "attendu_especes_cents",
                "attendu_cheques_cents", "remis_par", "recu_par", "note", "created_at", "confirme_le")


def add_remise(r: dict) -> dict:
    with get_conn() as conn:
        rid = conn.execute(
            f"INSERT INTO remises ({', '.join(_REMISE_COLS[1:12])}) VALUES ({', '.join('?' * 11)})",
            tuple(r[k] for k in _REMISE_COLS[1:11]) + (_now(),),
        ).lastrowid
        conn.commit()
    return get_remise(rid)


def get_remise(remise_id: int) -> dict | None:
    with get_conn() as conn:
        r = conn.execute(f"SELECT {', '.join(_REMISE_COLS)} FROM remises WHERE id = ?", (remise_id,)).fetchone()
    return dict(zip(_REMISE_COLS, r)) if r else None


def list_remises(annee: int, sector_id: int | None = None) -> list[dict]:
    sql = f"SELECT {', '.join(_REMISE_COLS)} FROM remises WHERE annee = ?"
    args: list = [annee]
    if sector_id is not None:
        sql += " AND sector_id = ?"
        args.append(sector_id)
    with get_conn() as conn:
        rows = conn.execute(sql + " ORDER BY id", args).fetchall()
    return [dict(zip(_REMISE_COLS, r)) for r in rows]


def confirm_remise(remise_id: int, confirmed: bool) -> dict | None:
    with get_conn() as conn:
        conn.execute("UPDATE remises SET confirme_le = ? WHERE id = ?", (_now() if confirmed else None, remise_id))
        conn.commit()
    return get_remise(remise_id)


def delete_remise(remise_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM remises WHERE id = ?", (remise_id,))
        conn.commit()


# ---- Sauvegardes ------------------------------------------------------------------

BACKUP_KEEP = 30


def backup_dir() -> str:
    return os.environ.get("BACKUP_DIR") or os.path.join(os.path.dirname(DB_PATH) or ".", "sauvegardes")


def make_backup(tag: str | None = None) -> str:
    """Copie cohérente de la base (API de sauvegarde SQLite), même pendant l'utilisation."""
    os.makedirs(backup_dir(), exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    name = f"calendriers-{stamp}{'-' + tag if tag else ''}.db"
    target = os.path.join(backup_dir(), name)
    with get_conn() as conn:
        dest = sqlite3.connect(target)
        try:
            conn.backup(dest)
        finally:
            dest.close()
    prune_backups()
    return name


def list_backups() -> list[dict]:
    folder = backup_dir()
    if not os.path.isdir(folder):
        return []
    out = []
    for name in sorted(os.listdir(folder), reverse=True):
        if name.startswith("calendriers-") and name.endswith(".db"):
            st = os.stat(os.path.join(folder, name))
            out.append({"nom": name, "taille": st.st_size,
                        "date": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat()})
    return out


def prune_backups(keep: int = BACKUP_KEEP) -> None:
    for item in list_backups()[keep:]:
        try:
            os.remove(os.path.join(backup_dir(), item["nom"]))
        except OSError:
            pass


def backup_done_today() -> bool:
    today = datetime.now().strftime("%Y-%m-%d")
    return any(b["nom"].startswith(f"calendriers-{today}") for b in list_backups())
