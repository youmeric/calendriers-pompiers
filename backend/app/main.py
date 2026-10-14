from __future__ import annotations

import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import auth, db
from .geo import point_in_polygon
from .models import LoginIn, SectorsIn, StatusUpdate

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


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="Calendriers Pompiers - Courzieu & Brussieu", lifespan=lifespan)

# fichiers produits par le pipeline, rechargés s'ils sont régénérés
_communes_cache: dict[str, tuple[float, dict]] = {}


def _load_commune(slug: str) -> dict:
    path = DATA_DIR / f"{slug}.json"
    if not slug.replace("-", "").isalnum() or not path.exists():
        raise HTTPException(status_code=404, detail=f"Commune inconnue: {slug}")
    mtime = path.stat().st_mtime
    cached = _communes_cache.get(slug)
    if cached and cached[0] == mtime:
        return cached[1]
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    data["_address_ids"] = {a["id"] for a in data["addresses"]}
    _communes_cache[slug] = (mtime, data)
    return data


def _assign(addresses: list[dict], sectors: list[dict]) -> tuple[dict[int, list[dict]], list[dict]]:
    """Affecte chaque adresse au premier secteur (dans l'ordre) qui la contient."""
    by_sector: dict[int, list[dict]] = {s["id"]: [] for s in sectors}
    outside = []
    for addr in addresses:
        for s in sectors:
            if point_in_polygon(addr["lat"], addr["lon"], s["polygon"]):
                by_sector[s["id"]].append(addr)
                break
        else:
            outside.append(addr)
    return by_sector, outside


# ---- API publique --------------------------------------------------------------

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
    sectors = db.list_sectors(slug)
    statuses = db.get_statuses(slug)
    by_sector, outside = _assign(data["addresses"], sectors)

    out = []
    for s in sectors:
        counts = {"fait": 0, "absent": 0, "refus": 0, "a_faire": 0}
        addresses = []
        for a in by_sector[s["id"]]:
            status = statuses.get(a["id"], {}).get("status")
            counts[status or "a_faire"] += 1
            addresses.append({k: a[k] for k in ("id", "label", "groupe", "nom_voie", "numero", "lat", "lon")}
                             | {"status": status})
        out.append({**s, "addresses": addresses, "counts": counts})

    commune = data["commune"]
    return {
        "commune": {"slug": slug, "nom": commune["nom"], "mairie": commune.get("mairie")},
        "sectors": out,
        "hors_secteur": len(outside),
    }


@app.post("/api/communes/{slug}/addresses/{address_id}/status")
def update_status(slug: str, address_id: str, payload: StatusUpdate):
    data = _load_commune(slug)
    if address_id not in data["_address_ids"]:
        raise HTTPException(status_code=404, detail="Adresse inconnue")
    return db.set_status(slug, address_id, payload.status, payload.note)


# ---- API admin -----------------------------------------------------------------

@app.post("/api/admin/login")
def login(payload: LoginIn, response: Response):
    if not auth.admin_password():
        raise HTTPException(status_code=503, detail="ADMIN_PASSWORD n'est pas configuré sur le serveur")
    if not auth.check_password(payload.password):
        time.sleep(1)  # ralentit les essais en série
        raise HTTPException(status_code=401, detail="Mot de passe incorrect")
    response.set_cookie(
        auth.COOKIE_NAME, auth.make_token(), max_age=auth.SESSION_SECONDS,
        httponly=True, samesite="strict", secure=auth.COOKIE_SECURE, path="/",
    )
    return {"ok": True}


@app.post("/api/admin/logout")
def logout(response: Response):
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/admin/me", dependencies=[Depends(auth.require_admin)])
def me():
    return {"admin": True}


@app.get("/api/admin/communes/{slug}", dependencies=[Depends(auth.require_admin)])
def admin_get_commune(slug: str):
    data = _load_commune(slug)
    return {
        "commune": data["commune"],
        "sectors": db.list_sectors(slug),
        "addresses": data["addresses"],
        "roads": data.get("roads", []),
        "buildings": data.get("buildings", []),
        "auto_sectors": [
            {k: s[k] for k in ("nom", "couleur", "polygon", "nb_adresses")}
            for s in data.get("auto_sectors", []) if len(s.get("polygon", [])) >= 3
        ],
    }


@app.put("/api/admin/communes/{slug}/sectors", dependencies=[Depends(auth.require_admin)])
def admin_save_sectors(slug: str, payload: SectorsIn):
    _load_commune(slug)
    sectors = db.replace_sectors(slug, [s.model_dump() for s in payload.sectors])
    return {"sectors": sectors}


@app.post("/api/admin/communes/{slug}/reset-statuses", dependencies=[Depends(auth.require_admin)])
def admin_reset_statuses(slug: str):
    _load_commune(slug)
    db.reset_statuses(slug)
    return {"ok": True}


# ---- Pages ---------------------------------------------------------------------

@app.get("/admin", include_in_schema=False)
def admin_page():
    return FileResponse(FRONTEND_DIR / "admin.html")


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
