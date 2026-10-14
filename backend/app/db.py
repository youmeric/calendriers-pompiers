"""Accès SQLite : secteurs dessinés par l'admin et statut de chaque adresse."""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

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
            """
        )
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


# ---- Secteurs ----------------------------------------------------------------

def list_sectors(commune_slug: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, nom, couleur, polygon FROM sectors WHERE commune_slug = ? ORDER BY position, id",
            (commune_slug,),
        ).fetchall()
    return [{"id": r[0], "nom": r[1], "couleur": r[2], "polygon": json.loads(r[3])} for r in rows]


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
                conn.execute(
                    "UPDATE sectors SET position = ?, nom = ?, couleur = ?, polygon = ?, updated_at = ? WHERE id = ?",
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
    return list_sectors(commune_slug)


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
