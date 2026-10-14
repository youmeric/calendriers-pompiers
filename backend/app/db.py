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
            """
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(sectors)")}
        if "limite" not in columns:
            conn.execute("ALTER TABLE sectors ADD COLUMN limite TEXT")
        if "limite_src" not in columns:
            conn.execute("ALTER TABLE sectors ADD COLUMN limite_src TEXT")
        conn.commit()


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

def get_statuses(commune_slug: str) -> dict[str, dict]:
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT address_id, status, note, updated_at FROM address_status WHERE commune_slug = ?",
            (commune_slug,),
        )
        return {row[0]: {"status": row[1], "note": row[2], "updated_at": row[3]} for row in cur.fetchall()}


def set_status(commune_slug: str, address_id: str, status: str | None, note: str | None) -> dict:
    if status is not None and status not in VALID_STATUSES:
        raise ValueError(f"statut invalide: {status}")
    now = _now()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO address_status (commune_slug, address_id, status, note, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(commune_slug, address_id)
            DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at
            """,
            (commune_slug, address_id, status, note, now),
        )
        conn.commit()
    return {"address_id": address_id, "status": status, "note": note, "updated_at": now}


def reset_statuses(commune_slug: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM address_status WHERE commune_slug = ?", (commune_slug,))
        conn.commit()
