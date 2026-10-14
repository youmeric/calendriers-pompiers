from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from . import db
from .models import StatusUpdate

DATA_DIR = Path(os.environ.get("SECTORS_DATA_DIR") or (Path(__file__).resolve().parent / "data"))


def _resolve_frontend_dir() -> Path:
    env = os.environ.get("FRONTEND_DIR")
    candidates = [Path(env)] if env else []
    here = Path(__file__).resolve()
    candidates += [here.parent.parent.parent / "frontend", here.parent.parent / "frontend"]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


FRONTEND_DIR = _resolve_frontend_dir()

app = FastAPI(title="Calendriers Pompiers - Courzieu & Brussieu")

_communes_cache: dict[str, dict] = {}


def _load_commune(slug: str) -> dict:
    if slug in _communes_cache:
        return _communes_cache[slug]
    path = DATA_DIR / f"{slug}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Commune inconnue: {slug}")
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    _communes_cache[slug] = data
    return data


@app.on_event("startup")
def on_startup() -> None:
    db.init_db()


@app.get("/api/communes")
def list_communes():
    index_path = DATA_DIR / "index.json"
    if not index_path.exists():
        return {"communes": []}
    with open(index_path, "r", encoding="utf-8") as fh:
        return json.load(fh)


@app.get("/api/communes/{slug}")
def get_commune(slug: str):
    data = _load_commune(slug)
    statuses = db.get_statuses(slug)

    sectors = []
    for sector in data["sectors"]:
        addresses = []
        counts = {"fait": 0, "absent": 0, "refus": 0, "a_faire": 0}
        for addr in sector["addresses"]:
            st = statuses.get(addr["id"], {})
            status = st.get("status")
            counts[status or "a_faire"] += 1
            addresses.append({**addr, "status": status, "note": st.get("note")})
        sectors.append({**sector, "addresses": addresses, "counts": counts})

    return {"commune": data["commune"], "sectors": sectors, "buildings": data.get("buildings", [])}


@app.post("/api/communes/{slug}/addresses/{address_id}/status")
def update_status(slug: str, address_id: str, payload: StatusUpdate):
    _load_commune(slug)  # 404 si commune inconnue
    try:
        result = db.set_status(slug, address_id, payload.status, payload.note)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return result


@app.post("/api/communes/{slug}/reset")
def reset_commune(slug: str):
    _load_commune(slug)
    db.reset_commune(slug)
    return {"ok": True}


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
