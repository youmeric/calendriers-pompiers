"""Accès SQLite pour le statut de distribution de chaque adresse."""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

DB_PATH = os.environ.get("DB_PATH", "db/status.db")

VALID_STATUSES = {"fait", "absent", "refus"}


def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS address_status (
                commune_slug TEXT NOT NULL,
                address_id TEXT NOT NULL,
                status TEXT,
                note TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (commune_slug, address_id)
            )
            """
        )
        conn.commit()


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()


def get_statuses(commune_slug: str) -> dict[str, dict]:
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT address_id, status, note, updated_at FROM address_status WHERE commune_slug = ?",
            (commune_slug,),
        )
        return {
            row[0]: {"status": row[1], "note": row[2], "updated_at": row[3]}
            for row in cur.fetchall()
        }


def set_status(commune_slug: str, address_id: str, status: str | None, note: str | None) -> dict:
    if status is not None and status not in VALID_STATUSES:
        raise ValueError(f"statut invalide: {status}")
    now = datetime.now(timezone.utc).isoformat()
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


def reset_commune(commune_slug: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM address_status WHERE commune_slug = ?", (commune_slug,))
        conn.commit()
