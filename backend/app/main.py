from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from . import auth, db
from .geo import point_in_polys
from .limits import RoadIndex, describe_limit_polys
from .models import ExclusionIn, LoginIn, SectorsIn, SettingsIn, StatusUpdate
from .resume import build_resume, commune_voie_counts

DATA_DIR = Path(os.environ.get("SECTORS_DATA_DIR") or (Path(__file__).resolve().parent / "data"))

mimetypes.add_type("application/manifest+json", ".webmanifest")


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


def _asset_version() -> str:
    """Empreinte des scripts et styles : change à chaque mise à jour du site."""
    h = hashlib.sha1()
    for path in sorted(FRONTEND_DIR.glob("**/*")):
        if path.suffix in {".js", ".css", ".html", ".webmanifest"} and path.is_file():
            h.update(path.read_bytes())
    return h.hexdigest()[:10]


ASSET_VERSION = _asset_version() if FRONTEND_DIR.exists() else "dev"


@app.middleware("http")
async def no_stale_files(request: Request, call_next):
    # Sans consigne, les navigateurs gardent pages et scripts en cache « au jugé » et
    # peuvent mélanger ancienne et nouvelle version après une mise à jour : on leur
    # demande de revérifier à chaque fois (réponse 304 légère si rien n'a changé).
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


def _page(name: str) -> HTMLResponse:
    """Page HTML dont les liens vers scripts/styles portent la version courante."""
    html = (FRONTEND_DIR / name).read_text(encoding="utf-8").replace("__V__", ASSET_VERSION)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

# fichiers produits par le pipeline, rechargés s'ils sont régénérés
_communes_cache: dict[str, dict] = {}


def _load_commune(slug: str) -> dict:
    path = DATA_DIR / f"{slug}.json"
    if not slug.replace("-", "").isalnum() or not path.exists():
        raise HTTPException(status_code=404, detail=f"Commune inconnue: {slug}")
    mtime = str(path.stat().st_mtime)
    cached = _communes_cache.get(slug)
    if cached and cached["_mtime"] == mtime:
        return cached
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    data["_mtime"] = mtime
    data["_address_ids"] = {a["id"] for a in data["addresses"]}
    _communes_cache[slug] = data
    return data


def _active_addresses(slug: str, data: dict) -> list[dict]:
    """Adresses de la commune moins celles exclues par l'admin (cimetière…)."""
    excluded = db.get_excluded(slug)
    if not excluded:
        return data["addresses"]
    return [a for a in data["addresses"] if a["id"] not in excluded]


def _road_index(data: dict) -> RoadIndex:
    if "_road_index" not in data:
        mairie = data["commune"].get("mairie") or {"lat": data["addresses"][0]["lat"], "lon": data["addresses"][0]["lon"]}
        data["_road_index"] = RoadIndex(data.get("roads", []), data["commune"].get("contour"),
                                        mairie["lat"], mairie["lon"])
    return data["_road_index"]


def _sectors_with_limits(slug: str, data: dict) -> list[dict]:
    """Secteurs enregistrés, avec la description de leur limite (recalculée si
    le tracé ou les données de la commune ont changé)."""
    sectors = db.list_sectors(slug)
    for s in sectors:
        if s["limite_src"] != data["_mtime"]:
            s["limite"] = describe_limit_polys(s["polygon"], _road_index(data))
            db.set_sector_limite(s["id"], s["limite"], data["_mtime"])
        s.pop("limite_src", None)
    return sectors


def _assign(addresses: list[dict], sectors: list[dict]) -> tuple[dict[int, list[dict]], list[dict]]:
    """Affecte chaque adresse au premier secteur (dans l'ordre) qui la contient."""
    by_sector: dict[int, list[dict]] = {s["id"]: [] for s in sectors}
    outside = []
    for addr in addresses:
        for s in sectors:
            if point_in_polys(addr["lat"], addr["lon"], s["polygon"]):
                by_sector[s["id"]].append(addr)
                break
        else:
            outside.append(addr)
    return by_sector, outside


def _suivi_enabled() -> bool:
    return db.get_setting("suivi_adresses", "0") == "1"


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
    sectors = _sectors_with_limits(slug, data)
    suivi = _suivi_enabled()
    statuses = db.get_statuses(slug) if suivi else {}
    addresses_all = _active_addresses(slug, data)
    voie_counts = commune_voie_counts(addresses_all)
    by_sector, outside = _assign(addresses_all, sectors)

    out = []
    for s in sectors:
        mine = by_sector[s["id"]]
        addresses = []
        counts = {"fait": 0, "absent": 0, "refus": 0, "a_faire": 0}
        for a in mine:
            item = {k: a.get(k, "") for k in ("id", "label", "groupe", "nom_voie", "numero", "lat", "lon")}
            if suivi:
                item["status"] = statuses.get(a["id"], {}).get("status")
                counts[item["status"] or "a_faire"] += 1
            addresses.append(item)
        sector = {**s, "addresses": addresses, "resume": build_resume(mine, voie_counts)}
        if suivi:
            sector["counts"] = counts
        out.append(sector)

    commune = data["commune"]
    return {
        "commune": {"slug": slug, "nom": commune["nom"], "mairie": commune.get("mairie"),
                    "contour": commune.get("contour")},
        "suivi": suivi,
        "sectors": out,
        "hors_secteur": len(outside),
    }


@app.post("/api/communes/{slug}/addresses/{address_id}/status")
def update_status(slug: str, address_id: str, payload: StatusUpdate):
    if not _suivi_enabled():
        raise HTTPException(status_code=403, detail="Le suivi des adresses est désactivé")
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


@app.get("/api/admin/settings", dependencies=[Depends(auth.require_admin)])
def admin_get_settings():
    return {"suivi_adresses": _suivi_enabled()}


@app.put("/api/admin/settings", dependencies=[Depends(auth.require_admin)])
def admin_save_settings(payload: SettingsIn):
    db.set_setting("suivi_adresses", "1" if payload.suivi_adresses else "0")
    return {"suivi_adresses": payload.suivi_adresses}


@app.get("/api/admin/communes/{slug}", dependencies=[Depends(auth.require_admin)])
def admin_get_commune(slug: str):
    data = _load_commune(slug)
    return {
        "commune": data["commune"],
        "sectors": _sectors_with_limits(slug, data),
        "addresses": data["addresses"],
        "excluded": sorted(db.get_excluded(slug)),
        "roads": data.get("roads", []),
        "buildings": data.get("buildings", []),
        "auto_sectors": [
            {k: s[k] for k in ("nom", "couleur", "polygon", "nb_adresses")}
            for s in data.get("auto_sectors", []) if len(s.get("polygon", [])) >= 3
        ],
    }


@app.put("/api/admin/communes/{slug}/sectors", dependencies=[Depends(auth.require_admin)])
def admin_save_sectors(slug: str, payload: SectorsIn):
    data = _load_commune(slug)
    db.replace_sectors(slug, [s.model_dump() for s in payload.sectors])
    return {"sectors": _sectors_with_limits(slug, data)}


@app.put("/api/admin/communes/{slug}/excluded", dependencies=[Depends(auth.require_admin)])
def admin_set_excluded(slug: str, payload: ExclusionIn):
    data = _load_commune(slug)
    unknown = [a for a in payload.address_ids if a not in data["_address_ids"]]
    if unknown:
        raise HTTPException(status_code=404, detail=f"Adresse(s) inconnue(s) : {', '.join(unknown[:5])}")
    db.set_excluded(slug, payload.address_ids, payload.excluded)
    return {"excluded": sorted(db.get_excluded(slug))}


@app.get("/api/admin/communes/{slug}/versions", dependencies=[Depends(auth.require_admin)])
def admin_list_versions(slug: str):
    _load_commune(slug)
    return {"versions": db.list_versions(slug)}


@app.get("/api/admin/communes/{slug}/versions/{version_id}", dependencies=[Depends(auth.require_admin)])
def admin_get_version(slug: str, version_id: int):
    _load_commune(slug)
    sectors = db.get_version(slug, version_id)
    if sectors is None:
        raise HTTPException(status_code=404, detail="Version inconnue")
    return {"sectors": sectors}


@app.post("/api/admin/communes/{slug}/reset-statuses", dependencies=[Depends(auth.require_admin)])
def admin_reset_statuses(slug: str):
    _load_commune(slug)
    db.reset_statuses(slug)
    return {"ok": True}


# ---- Pages ---------------------------------------------------------------------

@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def public_page():
    return _page("index.html")


@app.get("/admin", include_in_schema=False)
@app.get("/admin.html", include_in_schema=False)
def admin_page():
    return _page("admin.html")


@app.get("/plan.html", include_in_schema=False)
def plan_page():
    return _page("plan.html")


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
