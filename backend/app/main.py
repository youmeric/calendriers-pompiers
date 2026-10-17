from __future__ import annotations

import hashlib
import json
import asyncio
import logging
import mimetypes
import re
import secrets
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from . import auth, db
from .geo import point_in_polys
from .limits import RoadIndex, describe_limit_polys
from .models import (AvancementIn, CodeIn, ConfirmIn, DonIn, DonStatutIn, EquipeIn, ExclusionIn, LoginIn, PersonneIn,
                     PersonnesIn, RemiseIn, RenfortIn, SectorsIn, SettingsIn, StatusUpdate, SumupRetourIn,
                     NoteIn, SignalementIn, SignalementActionIn)
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


log = logging.getLogger("calendriers")


async def _daily_backups() -> None:
    """Une sauvegarde de la base par jour (vérifié chaque heure), 30 gardées."""
    await asyncio.sleep(60)  # laisse le serveur démarrer
    while True:
        try:
            if not await asyncio.to_thread(db.backup_done_today):
                name = await asyncio.to_thread(db.make_backup)
                log.info("Sauvegarde créée : %s", name)
        except Exception:  # une sauvegarde ratée ne doit jamais arrêter le site
            log.exception("Sauvegarde automatique impossible")
        await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    task = asyncio.create_task(_daily_backups()) if os.environ.get("AUTO_BACKUP", "1") != "0" else None
    yield
    if task:
        task.cancel()


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


def _addresses(slug: str, data: dict) -> list[dict]:
    """Adresses de la commune : Base Adresse + maisons ajoutées par l'admin. Une maison ajoutée
    prend le hameau (groupe) de l'adresse connue la plus proche."""
    added = db.list_added_addresses(slug)
    if not added:
        return data["addresses"]
    base = data["addresses"]
    out = list(base)
    for a in added:
        near = min(base, key=lambda b: (b["lat"] - a["lat"]) ** 2 + ((b["lon"] - a["lon"]) * 0.7) ** 2) if base else {}
        label = " ".join(x for x in (a["numero"], a["nom_voie"]) if x) or "Maison ajoutée"
        out.append({**a, "label": label, "rep": "", "lieu_dit": near.get("lieu_dit", ""),
                    "groupe_id": near.get("groupe_id"), "groupe": near.get("groupe", a["nom_voie"]),
                    "nom_voie": a["nom_voie"] or near.get("nom_voie", ""), "ajoutee": True})
    return out


def _address_ids(slug: str, data: dict) -> set[str]:
    added = db.list_added_addresses(slug)
    return data["_address_ids"] | {a["id"] for a in added} if added else data["_address_ids"]


def _active_addresses(slug: str, data: dict) -> list[dict]:
    """Adresses de la commune moins celles exclues par l'admin (cimetière…)."""
    excluded = db.get_excluded(slug)
    addresses = _addresses(slug, data)
    if not excluded:
        return addresses
    return [a for a in addresses if a["id"] not in excluded]


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

def _flag(key: str, default: bool) -> bool:
    return db.get_setting(key, "1" if default else "0") == "1"


def _public_teams() -> dict[int, dict]:
    """Équipes telles que montrées au public (sans téléphone sauf si l'admin l'a permis)."""
    if not _flag("equipes_public", True):
        return {}
    with_tel = _flag("telephones_public", False)
    people = {p["id"]: p for p in db.list_personnes()}
    out = {}
    for sector_id, team in db.get_teams().items():
        view = {k: team[k] for k in ("date", "creneau", "statut", "note")}
        view["responsables"], view["equipiers"] = [], []
        for m in team["membres"]:
            p = people.get(m["personne_id"])
            if not p:
                continue
            item = {"id": p["id"], "nom": p["nom"]}
            if with_tel and p["telephone"]:
                item["telephone"] = p["telephone"]
            view["responsables" if m["role"] == "responsable" else "equipiers"].append(item)
        out[sector_id] = view
    return out


def _annee() -> int:
    return db.current_annee()


@app.get("/api/communes")
def list_communes():
    index_path = DATA_DIR / "index.json"
    data = {"communes": []}
    if index_path.exists():
        with open(index_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    return {**data, "annee": _annee()}


@app.get("/api/communes/{slug}")
def get_commune(slug: str):
    data = _load_commune(slug)
    sectors = _sectors_with_limits(slug, data)
    suivi = _suivi_enabled()
    addresses_all = _active_addresses(slug, data)
    voie_counts = commune_voie_counts(addresses_all)
    by_sector, outside = _assign(addresses_all, sectors)
    teams = _public_teams() if _flag("equipes_public", True) else None

    out = []
    for s in sectors:
        mine = by_sector[s["id"]]
        addresses = [{k: a.get(k, "") for k in ("id", "label", "groupe", "nom_voie", "numero", "lat", "lon")} for a in mine]
        sector = {**s, "addresses": addresses, "resume": build_resume(mine, voie_counts)}
        if teams is not None:
            sector["equipe"] = teams.get(s["id"]) or {
                "date": "", "creneau": "", "statut": "a_faire", "note": "", "responsables": [], "equipiers": []}
        out.append(sector)

    commune = data["commune"]
    return {
        "commune": {"slug": slug, "nom": commune["nom"], "mairie": commune.get("mairie"),
                    "contour": commune.get("contour")},
        "suivi": suivi,
        "dons": suivi and _flag("dons_actifs", False),
        "sectors": out,
        "hors_secteur": len(outside),
    }


@app.post("/api/communes/{slug}/addresses/{address_id}/status")
def update_status(slug: str, address_id: str, payload: StatusUpdate, request: Request):
    if not _suivi_enabled():
        raise HTTPException(status_code=403, detail="Le suivi des adresses est désactivé")
    sector_id = _sector_of_address(slug, address_id)
    _require_role(request, sector_id)
    return db.set_status(slug, address_id, payload.status, payload.note)


# ---- Accès des équipes (code personnel) --------------------------------------------

def _sector_map(slug: str) -> tuple[dict, list[dict], dict[int, list[dict]]]:
    data = _load_commune(slug)
    sectors = db.list_sectors(slug)
    by_sector, _ = _assign(_active_addresses(slug, data), sectors)
    return data, sectors, by_sector


def _sector_of_address(slug: str, address_id: str) -> int:
    data, _, by_sector = _sector_map(slug)
    if address_id not in _address_ids(slug, data):
        raise HTTPException(status_code=404, detail="Adresse inconnue")
    for sector_id, addresses in by_sector.items():
        if any(a["id"] == address_id for a in addresses):
            return sector_id
    raise HTTPException(status_code=404, detail="Adresse hors secteur")


def _role(request: Request, sector_id: int) -> str | None:
    """Rôle de la personne connectée sur un secteur : admin, responsable, equipier ou None."""
    if auth.is_admin(request):
        return "admin"
    person = auth.team_member(request)
    if not person:
        return None
    return db.memberships(person["id"]).get(sector_id)


def _require_role(request: Request, sector_id: int) -> str:
    role = _role(request, sector_id)
    if role:
        return role
    if not auth.is_admin(request) and not auth.team_member(request):
        raise HTTPException(status_code=401, detail="Connectez-vous avec votre code d'équipe")
    raise HTTPException(status_code=403, detail="Ce secteur n'est pas le vôtre")


def _team_view(sector_id: int) -> dict:
    """L'équipe d'un secteur telle que ses membres la voient (avec les téléphones)."""
    team = db.get_teams().get(sector_id) or {"date": "", "creneau": "", "statut": "a_faire", "note": "", "membres": []}
    people = {p["id"]: p for p in db.list_personnes()}
    view = {k: team[k] for k in ("date", "creneau", "statut", "note")}
    view["responsables"], view["equipiers"] = [], []
    for m in team["membres"]:
        p = people.get(m["personne_id"])
        if p:
            view["responsables" if m["role"] == "responsable" else "equipiers"].append(
                {"id": p["id"], "nom": p["nom"], "telephone": p["telephone"]})
    return view


def _sumup_config() -> dict | None:
    key = db.get_setting("sumup_affiliate_key", "") or ""
    if not (_flag("sumup_actif", False) and _flag("dons_actifs", False) and key):
        return None
    return {"affiliate_key": key, "app_id": db.get_setting("sumup_app_id", "") or ""}


@app.post("/api/equipe/login")
def team_login(payload: CodeIn, request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    if auth.too_many_attempts(ip):
        raise HTTPException(status_code=429, detail="Trop d'essais : réessayez dans quelques minutes")
    person = db.get_personne_by_code(payload.code)
    if not person:
        auth.record_failure(ip)
        time.sleep(1)  # ralentit les essais en série
        raise HTTPException(status_code=401, detail="Code inconnu")
    response.set_cookie(
        auth.TEAM_COOKIE, auth.make_team_token(person["id"], person["code"]), max_age=auth.TEAM_SECONDS,
        httponly=True, samesite="strict", secure=auth.COOKIE_SECURE, path="/",
    )
    return {"ok": True, "nom": person["nom"]}


@app.post("/api/equipe/logout")
def team_logout(response: Response):
    response.delete_cookie(auth.TEAM_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/equipe/moi")
def team_me(request: Request):
    admin = auth.is_admin(request)
    person = auth.team_member(request)
    if not admin and not person:
        raise HTTPException(status_code=401, detail="Non connecté")
    roles = {} if admin else db.memberships(person["id"])
    return {
        "admin": admin,
        "personne": {"id": person["id"], "nom": person["nom"]} if person else None,
        "secteurs": [{"sector_id": sid, "role": role} for sid, role in roles.items()],
        "suivi": _suivi_enabled(),
        "dons": _suivi_enabled() and _flag("dons_actifs", False),
        "sumup": _sumup_config(),
    }


def _don_view(d: dict, full: bool, me: int | None) -> dict:
    mine = me is not None and d["personne_id"] == me
    view = {k: d[k] for k in ("id", "address_id", "mode", "statut", "note", "personne_nom", "created_at")}
    view["mine"] = mine
    if full or mine:
        view["montant"] = d["montant_cents"] / 100
        view["tx_code"] = d["tx_code"]
    return view


def _totaux(dons: list[dict]) -> dict:
    tot = {"total": 0, "especes": 0, "cheque": 0, "cb": 0, "nb": 0, "attente": 0}
    for d in dons:
        if d["statut"] == "attente":
            tot["attente"] += 1
        if d["statut"] != "ok":
            continue
        tot["nb"] += 1
        tot[d["mode"]] += d["montant_cents"]
        tot["total"] += d["montant_cents"]
    return {k: (v / 100 if k not in ("nb", "attente") else v) for k, v in tot.items()}


@app.get("/api/equipe/secteurs/{sector_id}/suivi")
def team_sector_tracking(sector_id: int, request: Request):
    if not _suivi_enabled():
        raise HTTPException(status_code=403, detail="Le suivi des adresses est désactivé")
    role = _require_role(request, sector_id)
    slug = next((c for c, ids in db.sector_communes().items() if sector_id in ids), None)
    if slug is None:
        raise HTTPException(status_code=404, detail="Secteur inconnu")
    _, _, by_sector = _sector_map(slug)
    ids = {a["id"] for a in by_sector.get(sector_id, [])}
    statuses = {aid: st for aid, st in db.get_statuses(slug).items() if aid in ids and st.get("status")}
    full = role in ("admin", "responsable")
    person = auth.team_member(request)
    me = person["id"] if person else None
    out = {"slug": slug, "role": role, "statuses": statuses, "dons": None, "totaux": None, "precedent": {},
           "equipe": _team_view(sector_id),
           "notes": {aid: n for aid, n in db.get_notes(slug).items() if aid in ids},
           "signalements": [_sig_view(x) for x in db.list_signalements(sector_id, open_only=True)]}
    for aid, prev in db.previous_year(slug, _annee()).items():
        if aid in ids:
            item = {"annee": prev["annee"], "status": prev["status"], "nb_dons": prev["nb_dons"]}
            if full:
                item["montant"] = prev["montant_cents"] / 100
            out["precedent"][aid] = item
    if _flag("dons_actifs", False):
        dons = db.list_dons(_annee(), sector_id)
        out["dons"] = [_don_view(d, full, me) for d in dons]
        if full:
            out["totaux"] = _totaux(dons)
    return out


@app.post("/api/equipe/dons")
def team_add_don(payload: DonIn, request: Request):
    if not (_suivi_enabled() and _flag("dons_actifs", False)):
        raise HTTPException(status_code=403, detail="L'enregistrement des dons est désactivé")
    sector_id = _sector_of_address(payload.slug, payload.address_id)
    _require_role(request, sector_id)
    person = auth.team_member(request)
    use_sumup = payload.mode == "cb" and payload.sumup
    if use_sumup and not _sumup_config():
        raise HTTPException(status_code=409, detail="Le paiement SumUp n'est pas configuré")
    don, created = db.add_don({
        "annee": _annee(), "commune_slug": payload.slug, "address_id": payload.address_id, "sector_id": sector_id,
        "montant_cents": round(payload.montant * 100), "mode": payload.mode,
        "statut": "attente" if use_sumup else "ok",
        "foreign_id": f"cal-{secrets.token_hex(12)}" if use_sumup else None,
        "tx_code": payload.tx_code, "note": payload.note,
        "personne_id": person["id"] if person else None, "personne_nom": person["nom"] if person else "Admin",
        "client_id": payload.client_id,
    })
    # un don reçu veut dire que la maison est faite (paiement carte : une fois confirmé)
    if created and don["statut"] == "ok":
        db.set_status(payload.slug, payload.address_id, "fait", None)
    view = _don_view(don, True, None)
    view["foreign_id"] = don["foreign_id"]
    return view


def _don_for_edit(request: Request, don_id: int) -> dict:
    don = db.get_don(don_id)
    if not don:
        raise HTTPException(status_code=404, detail="Don inconnu")
    role = _require_role(request, don["sector_id"])
    person = auth.team_member(request)
    if role == "equipier" and not (person and don["personne_id"] == person["id"]):
        raise HTTPException(status_code=403, detail="Seul le responsable du secteur peut modifier ce don")
    return don


@app.post("/api/equipe/dons/{don_id}/statut")
def team_don_statut(don_id: int, payload: DonStatutIn, request: Request):
    don = _don_for_edit(request, don_id)
    updated = db.set_don_statut(don["id"], payload.statut, payload.tx_code or None)
    if updated["statut"] == "ok":
        db.set_status(updated["commune_slug"], updated["address_id"], "fait", None)
    return _don_view(updated, True, None)


@app.delete("/api/equipe/dons/{don_id}")
def team_delete_don(don_id: int, request: Request):
    don = _don_for_edit(request, don_id)
    db.delete_don(don["id"])
    return {"ok": True}


# ---- Notes et signalements des équipes ------------------------------------------------

def _person_name(request: Request) -> str:
    person = auth.team_member(request)
    return person["nom"] if person else "Admin"


@app.post("/api/equipe/notes")
def team_set_note(payload: NoteIn, request: Request):
    """Note de l'équipe sur une maison (vide = effacée), gardée d'une année sur l'autre."""
    if not _suivi_enabled():
        raise HTTPException(status_code=403, detail="Le suivi des adresses est désactivé")
    _require_role(request, _sector_of_address(payload.slug, payload.address_id))
    return {"note": db.set_note(payload.slug, payload.address_id, payload.note, _person_name(request))}


def _sig_view(x: dict) -> dict:
    return {k: x[k] for k in ("id", "type", "address_id", "lat", "lon", "numero", "nom_voie", "note",
                              "personne_nom", "statut", "created_at")}


@app.post("/api/equipe/signalements")
def team_report(payload: SignalementIn, request: Request):
    """Maison manquante, vide ou démolie, adresse fausse… vue sur le terrain ; l'admin tranche."""
    if payload.type == "manquante":
        sector_id = payload.sector_id
        if sector_id not in db.sector_communes().get(payload.slug, set()):
            raise HTTPException(status_code=404, detail="Secteur inconnu")
    else:
        sector_id = _sector_of_address(payload.slug, payload.address_id)
    _require_role(request, sector_id)
    sig = db.add_signalement({**payload.model_dump(exclude={"slug", "sector_id"}), "commune_slug": payload.slug,
                              "sector_id": sector_id, "personne_nom": _person_name(request)})
    return _sig_view(sig)


@app.get("/api/admin/signalements", dependencies=[Depends(auth.require_admin)])
def admin_reports():
    labels: dict[str, dict] = {}
    for slug in db.sector_communes():
        for a in _addresses(slug, _load_commune(slug)):
            labels[f"{slug}/{a['id']}"] = a
    sectors = {s["id"]: s["nom"] for slug in db.sector_communes() for s in db.list_sectors(slug)}
    excluded = {slug: db.get_excluded(slug) for slug in db.sector_communes()}
    out = []
    for x in db.list_signalements():
        a = labels.get(f"{x['commune_slug']}/{x['address_id']}") if x["address_id"] else None
        out.append({**_sig_view(x), "slug": x["commune_slug"], "sector_id": x["sector_id"],
                    "secteur": sectors.get(x["sector_id"], ""), "adresse": a["label"] if a else "",
                    "lat": x["lat"] if x["lat"] is not None else (a or {}).get("lat"),
                    "lon": x["lon"] if x["lon"] is not None else (a or {}).get("lon"),
                    "exclue": bool(a and a["id"] in excluded.get(x["commune_slug"], set())),
                    "traite_le": x["traite_le"]})
    return {"signalements": out}


@app.post("/api/admin/signalements/{sig_id}", dependencies=[Depends(auth.require_admin)])
def admin_handle_report(sig_id: int, payload: SignalementActionIn):
    sig = db.get_signalement(sig_id)
    if not sig:
        raise HTTPException(status_code=404, detail="Signalement inconnu")
    added = None
    if payload.action == "ajouter":
        if sig["type"] != "manquante":
            raise HTTPException(status_code=409, detail="Seule une maison manquante peut être ajoutée")
        _load_commune(sig["commune_slug"])
        added = db.add_address(sig["commune_slug"], payload.numero or sig["numero"], payload.nom_voie or sig["nom_voie"],
                               sig["lat"], sig["lon"])
    elif payload.action == "exclure":
        if not sig["address_id"]:
            raise HTTPException(status_code=409, detail="Aucune adresse à exclure")
        db.set_excluded(sig["commune_slug"], [sig["address_id"]], True)
    statut = {"rouvrir": "nouveau", "ignore": "ignore"}.get(payload.action, "traite")
    return {**_sig_view(db.set_signalement_statut(sig_id, statut)), "adresse_ajoutee": added}


# ---- Caisse : remise des espèces et chèques au trésorier ------------------------------

def _caisse(sector_id: int) -> dict:
    annee = _annee()
    dons = [d for d in db.list_dons(annee, sector_id) if d["statut"] == "ok"]
    remises = db.list_remises(annee, sector_id)
    attendu = {"especes": sum(d["montant_cents"] for d in dons if d["mode"] == "especes"),
               "cheques": sum(d["montant_cents"] for d in dons if d["mode"] == "cheque"),
               "nb_cheques": sum(1 for d in dons if d["mode"] == "cheque")}
    remis = {"especes": sum(r["especes_cents"] for r in remises), "cheques": sum(r["cheques_cents"] for r in remises),
             "nb_cheques": sum(r["nb_cheques"] for r in remises)}
    euros = lambda c: c / 100  # noqa: E731
    return {
        "attendu": {"especes": euros(attendu["especes"]), "cheques": euros(attendu["cheques"]), "nb_cheques": attendu["nb_cheques"]},
        "remis": {"especes": euros(remis["especes"]), "cheques": euros(remis["cheques"]), "nb_cheques": remis["nb_cheques"]},
        "reste": {"especes": euros(attendu["especes"] - remis["especes"]), "cheques": euros(attendu["cheques"] - remis["cheques"]),
                  "nb_cheques": attendu["nb_cheques"] - remis["nb_cheques"]},
        "remises": [{
            "id": r["id"], "especes": euros(r["especes_cents"]), "cheques": euros(r["cheques_cents"]),
            "nb_cheques": r["nb_cheques"], "remis_par": r["remis_par"], "recu_par": r["recu_par"], "note": r["note"],
            "created_at": r["created_at"], "confirme_le": r["confirme_le"],
            "ecart_especes": euros(r["especes_cents"] - r["attendu_especes_cents"]),
            "ecart_cheques": euros(r["cheques_cents"] - r["attendu_cheques_cents"]),
        } for r in remises],
    }


def _require_lead(request: Request, sector_id: int, detail: str = "La caisse est gérée par le responsable du secteur") -> str:
    role = _require_role(request, sector_id)
    if role == "equipier":
        raise HTTPException(status_code=403, detail=detail)
    return role


@app.post("/api/equipe/secteurs/{sector_id}/avancement")
def team_sector_progress(sector_id: int, payload: AvancementIn, request: Request):
    """Le responsable indique où en est son secteur (à faire / en cours / terminé)."""
    _require_lead(request, sector_id)
    db.set_sector_statut(sector_id, payload.statut)
    return _team_view(sector_id)


@app.get("/api/equipe/secteurs/{sector_id}/equipe")
def team_sector_team(sector_id: int, request: Request):
    """L'équipe du secteur (avec téléphones), pour ses membres, même quand le suivi est coupé."""
    _require_role(request, sector_id)
    return _team_view(sector_id)


TEAM_LEAD_ONLY = "Seul le responsable du secteur modifie l'équipe"


@app.get("/api/equipe/secteurs/{sector_id}/personnes")
def team_people(sector_id: int, request: Request):
    """Personnes de la caserne qu'un responsable peut appeler en renfort (noms seulement),
    avec les secteurs où elles sont déjà prévues (et si c'est le même jour)."""
    _require_lead(request, sector_id, TEAM_LEAD_ONLY)
    teams = db.get_teams()
    team = teams.get(sector_id) or {"date": "", "membres": []}
    inside = {m["personne_id"] for m in team["membres"]}
    elsewhere: dict[int, list[dict]] = {}
    for sid, t in teams.items():
        if sid == sector_id:
            continue
        for m in t["membres"]:
            elsewhere.setdefault(m["personne_id"], []).append(
                {"sector_id": sid, "meme_jour": bool(team["date"]) and t["date"] == team["date"]})
    return {"personnes": [{"id": p["id"], "nom": p["nom"], "ailleurs": elsewhere.get(p["id"], [])}
                          for p in db.list_personnes() if p["id"] not in inside]}


@app.post("/api/equipe/secteurs/{sector_id}/equipiers")
def team_add_member(sector_id: int, payload: RenfortIn, request: Request):
    """Le responsable ajoute un équipier (remplaçant d'un absent, renfort…)."""
    _require_lead(request, sector_id, TEAM_LEAD_ONLY)
    if sector_id not in db.existing_sector_ids():
        raise HTTPException(status_code=404, detail="Secteur inconnu")
    if payload.personne is not None:
        if len(db.list_personnes()) >= 500:
            raise HTTPException(status_code=422, detail="Trop de personnes (500 au maximum)")
        pid = db.add_personnes([payload.personne.model_dump()])[0]["id"]
    else:
        if not db.get_personne(payload.personne_id):
            raise HTTPException(status_code=404, detail="Personne inconnue")
        pid = payload.personne_id
    if not db.add_member(sector_id, pid, "equipier"):
        raise HTTPException(status_code=409, detail="Cette personne fait déjà partie de l'équipe")
    return _team_view(sector_id)


@app.delete("/api/equipe/secteurs/{sector_id}/equipiers/{personne_id}")
def team_remove_member(sector_id: int, personne_id: int, request: Request):
    """Le responsable retire un équipier (absent) ; les responsables restent gérés par l'admin."""
    _require_lead(request, sector_id, TEAM_LEAD_ONLY)
    if not db.remove_member(sector_id, personne_id, "equipier"):
        raise HTTPException(status_code=404, detail="Cet équipier n'est pas dans l'équipe")
    return _team_view(sector_id)


@app.get("/api/equipe/secteurs/{sector_id}/caisse")
def team_cash(sector_id: int, request: Request):
    if not (_suivi_enabled() and _flag("dons_actifs", False)):
        raise HTTPException(status_code=403, detail="L'enregistrement des dons est désactivé")
    _require_lead(request, sector_id)
    return _caisse(sector_id)


@app.post("/api/equipe/secteurs/{sector_id}/remises")
def team_cash_handover(sector_id: int, payload: RemiseIn, request: Request):
    if not (_suivi_enabled() and _flag("dons_actifs", False)):
        raise HTTPException(status_code=403, detail="L'enregistrement des dons est désactivé")
    role = _require_lead(request, sector_id)
    person = auth.team_member(request)
    before = _caisse(sector_id)["reste"]  # ce qui restait à remettre avant cette remise
    db.add_remise({
        "annee": _annee(), "sector_id": sector_id,
        "especes_cents": round(payload.especes * 100), "cheques_cents": round(payload.cheques * 100),
        "nb_cheques": payload.nb_cheques,
        "attendu_especes_cents": round(before["especes"] * 100), "attendu_cheques_cents": round(before["cheques"] * 100),
        "remis_par": person["nom"] if person else ("Admin" if role == "admin" else "?"),
        "recu_par": payload.recu_par, "note": payload.note,
    })
    return _caisse(sector_id)


@app.post("/api/admin/remises/{remise_id}/confirmer", dependencies=[Depends(auth.require_admin)])
def admin_confirm_handover(remise_id: int, payload: ConfirmIn):
    if not db.get_remise(remise_id):
        raise HTTPException(status_code=404, detail="Remise inconnue")
    return db.confirm_remise(remise_id, payload.confirme)


@app.delete("/api/admin/remises/{remise_id}", dependencies=[Depends(auth.require_admin)])
def admin_delete_handover(remise_id: int):
    if not db.get_remise(remise_id):
        raise HTTPException(status_code=404, detail="Remise inconnue")
    db.delete_remise(remise_id)
    return {"ok": True}


# ---- Sauvegardes --------------------------------------------------------------------

BACKUP_NAME = re.compile(r"^calendriers-[0-9_-]+(-[a-z]+)?\.db$")


@app.get("/api/admin/sauvegardes", dependencies=[Depends(auth.require_admin)])
def admin_list_backups():
    return {"sauvegardes": db.list_backups(), "dossier": db.backup_dir(), "garde": db.BACKUP_KEEP}


@app.post("/api/admin/sauvegardes", dependencies=[Depends(auth.require_admin)])
def admin_backup_now():
    name = db.make_backup("manuelle")
    return {"nom": name, "sauvegardes": db.list_backups()}


@app.get("/api/admin/sauvegardes/{name}", dependencies=[Depends(auth.require_admin)])
def admin_download_backup(name: str):
    path = Path(db.backup_dir()) / name
    if not BACKUP_NAME.match(name) or not path.is_file():
        raise HTTPException(status_code=404, detail="Sauvegarde inconnue")
    return FileResponse(path, media_type="application/octet-stream", filename=name)


# ---- Retour de l'appli SumUp ----------------------------------------------------------
# L'appli SumUp rouvre /sumup-retour/<id> ; la page transmet le résultat ici. Pas besoin de
# session (l'appli peut rouvrir un autre navigateur) : l'identifiant aléatoire du don suffit.

@app.post("/api/sumup/retour")
def sumup_return(payload: SumupRetourIn):
    don = db.get_don_by_foreign(payload.foreign_id)
    if not don:
        raise HTTPException(status_code=404, detail="Paiement inconnu")
    if don["statut"] == "attente":
        statut = "ok" if payload.status.lower() == "success" else "echec"
        don = db.set_don_statut(don["id"], statut, payload.tx_code or None)
        if statut == "ok":
            db.set_status(don["commune_slug"], don["address_id"], "fait", None)
    return {"statut": don["statut"], "montant": don["montant_cents"] / 100, "mode": don["mode"],
            "slug": don["commune_slug"], "sector_id": don["sector_id"], "address_id": don["address_id"]}


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
    return {"suivi_adresses": _suivi_enabled(), "annee": _annee(),
            "equipes_public": _flag("equipes_public", True), "telephones_public": _flag("telephones_public", False),
            "dons_actifs": _flag("dons_actifs", False), "sumup_actif": _flag("sumup_actif", False),
            "sumup_affiliate_key": db.get_setting("sumup_affiliate_key", "") or "",
            "sumup_app_id": db.get_setting("sumup_app_id", "") or ""}


@app.put("/api/admin/settings", dependencies=[Depends(auth.require_admin)])
def admin_save_settings(payload: SettingsIn):
    if payload.suivi_adresses is not None:
        db.set_setting("suivi_adresses", "1" if payload.suivi_adresses else "0")
    if payload.annee is not None:
        db.set_setting("annee", str(payload.annee))
    for key in ("equipes_public", "telephones_public", "dons_actifs", "sumup_actif"):
        value = getattr(payload, key)
        if value is not None:
            db.set_setting(key, "1" if value else "0")
    for key in ("sumup_affiliate_key", "sumup_app_id"):
        value = getattr(payload, key)
        if value is not None:
            db.set_setting(key, value)
    return admin_get_settings()


# ---- Équipes ---------------------------------------------------------------------

@app.get("/api/admin/equipes", dependencies=[Depends(auth.require_admin)])
def admin_get_equipes():
    sector_ids = db.existing_sector_ids()
    teams = {sid: t for sid, t in db.get_teams().items() if sid in sector_ids}
    return {"personnes": db.list_personnes(), "equipes": teams}


@app.post("/api/admin/personnes", dependencies=[Depends(auth.require_admin)])
def admin_add_personnes(payload: PersonnesIn):
    if len(db.list_personnes()) + len(payload.personnes) > 500:
        raise HTTPException(status_code=422, detail="Trop de personnes (500 au maximum)")
    return {"personnes": db.add_personnes([p.model_dump() for p in payload.personnes])}


@app.put("/api/admin/personnes/{personne_id}", dependencies=[Depends(auth.require_admin)])
def admin_update_personne(personne_id: int, payload: PersonneIn):
    person = db.update_personne(personne_id, payload.nom, payload.telephone)
    if person is None:
        raise HTTPException(status_code=404, detail="Personne inconnue")
    return person


@app.delete("/api/admin/personnes/{personne_id}", dependencies=[Depends(auth.require_admin)])
def admin_delete_personne(personne_id: int):
    if not db.delete_personne(personne_id):
        raise HTTPException(status_code=404, detail="Personne inconnue")
    return {"ok": True}


@app.post("/api/admin/personnes/{personne_id}/code", dependencies=[Depends(auth.require_admin)])
def admin_regenerate_code(personne_id: int):
    person = db.regenerate_code(personne_id)
    if person is None:
        raise HTTPException(status_code=404, detail="Personne inconnue")
    return person


@app.get("/api/admin/bilan", dependencies=[Depends(auth.require_admin)])
def admin_bilan():
    annee = _annee()
    dons = db.list_dons(annee)
    rows = []
    for slug, sector_ids in db.sector_communes().items():
        data, sectors, by_sector = _sector_map(slug)
        statuses = db.get_statuses(slug)
        for s in sectors:
            ids = [a["id"] for a in by_sector.get(s["id"], [])]
            counts = {"fait": 0, "absent": 0, "refus": 0, "a_faire": 0}
            for aid in ids:
                counts[(statuses.get(aid) or {}).get("status") or "a_faire"] += 1
            rows.append({"sector_id": s["id"], "slug": slug, "commune": data["commune"]["nom"], "nom": s["nom"],
                         "couleur": s["couleur"], "adresses": len(ids), "counts": counts,
                         "polygon": s["polygon"],
                         "totaux": _totaux([d for d in dons if d["sector_id"] == s["id"]]),
                         "caisse": _caisse(s["id"])})
    return {"annee": annee, "secteurs": rows, "totaux": _totaux(dons),
            "attente": [_don_view(d, True, None) | {"sector_id": d["sector_id"], "slug": d["commune_slug"]}
                        for d in dons if d["statut"] == "attente"]}


@app.get("/api/admin/bilan-annee", dependencies=[Depends(auth.require_admin)])
def admin_year_report(annee: int | None = None):
    """Bilan d'une tournée comparé à la précédente, sur les secteurs actuels : les maisons et les dons
    de l'an dernier sont rangés dans le secteur où se trouve aujourd'hui leur adresse."""
    annees = db.list_annees()
    annee = annee or _annee()
    prev = max((a for a in annees if a < annee), default=None)
    years = [y for y in (annee, prev) if y is not None]
    people = {p["id"]: p["nom"] for p in db.list_personnes()}
    teams = db.get_teams()

    def blank() -> dict:
        return {"adresses": 0, "fait": 0, "absent": 0, "refus": 0, "dons": []}

    rows, totals = [], {y: blank() for y in years}
    for slug in db.sector_communes():
        data, sectors, by_sector = _sector_map(slug)
        where = {a["id"]: sid for sid, addrs in by_sector.items() for a in addrs}
        per = {s["id"]: {y: blank() for y in years} for s in sectors}
        for y in years:
            statuses = db.get_statuses(slug, y)
            for aid, sid in where.items():
                st = (statuses.get(aid) or {}).get("status")
                per[sid][y]["adresses"] += 1
                if st:
                    per[sid][y][st] += 1
            for d in db.list_dons(y):
                if d["commune_slug"] != slug or d["statut"] != "ok":
                    continue
                sid = where.get(d["address_id"], d["sector_id"])
                if sid in per:
                    per[sid][y]["dons"].append(d)
                else:
                    totals[y]["dons"].append(d)  # secteur disparu : compté dans le total seulement
        for s in sectors:
            team = teams.get(s["id"]) or {"membres": []}
            rows.append({"sector_id": s["id"], "commune": data["commune"]["nom"], "slug": slug, "nom": s["nom"],
                         "couleur": s["couleur"],
                         "responsables": [people[m["personne_id"]] for m in team["membres"]
                                          if m["role"] == "responsable" and m["personne_id"] in people],
                         "annees": {}})
            for y in years:
                v = per[s["id"]][y]
                for k in ("adresses", "fait", "absent", "refus"):
                    totals[y][k] += v[k]
                totals[y]["dons"].extend(v["dons"])
                rows[-1]["annees"][str(y)] = {**{k: v[k] for k in ("adresses", "fait", "absent", "refus")},
                                             "dons": _totaux(v["dons"])}
    remises = db.list_remises(annee)
    return {
        "annee": annee, "precedente": prev, "annees": annees, "secteurs": rows,
        "totaux": {str(y): {**{k: t[k] for k in ("adresses", "fait", "absent", "refus")}, "dons": _totaux(t["dons"])}
                   for y, t in totals.items()},
        "remises": {"nb": len(remises), "total": sum(r["especes_cents"] + r["cheques_cents"] for r in remises) / 100,
                    "confirmees": sum(1 for r in remises if r["confirme_le"])},
    }


@app.get("/api/admin/dons", dependencies=[Depends(auth.require_admin)])
def admin_dons():
    labels = {}
    for slug in db.sector_communes():
        labels.update({a["id"]: a["label"] for a in _addresses(slug, _load_commune(slug))})
    return {"annee": _annee(), "dons": [
        {**_don_view(d, True, None), "sector_id": d["sector_id"], "slug": d["commune_slug"],
         "adresse": labels.get(d["address_id"], d["address_id"])}
        for d in db.list_dons(_annee())
    ]}


@app.put("/api/admin/secteurs/{sector_id}/equipe", dependencies=[Depends(auth.require_admin)])
def admin_set_equipe(sector_id: int, payload: EquipeIn):
    if sector_id not in db.existing_sector_ids():
        raise HTTPException(status_code=404, detail="Secteur inconnu (a-t-il été supprimé ?)")
    known = {p["id"] for p in db.list_personnes()}
    unknown = [m.personne_id for m in payload.membres if m.personne_id not in known]
    if unknown:
        raise HTTPException(status_code=404, detail="Personne inconnue dans l'équipe")
    plan = payload.model_dump(exclude={"membres"})
    db.set_team(sector_id, plan, [m.model_dump() for m in payload.membres])
    return db.get_teams().get(sector_id)


@app.get("/api/admin/communes/{slug}", dependencies=[Depends(auth.require_admin)])
def admin_get_commune(slug: str):
    data = _load_commune(slug)
    return {
        "commune": data["commune"],
        "sectors": _sectors_with_limits(slug, data),
        "addresses": _addresses(slug, data),
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
    known = _address_ids(slug, data)
    unknown = [a for a in payload.address_ids if a not in known]
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


@app.get("/equipe", include_in_schema=False)
@app.get("/equipe.html", include_in_schema=False)
def team_page():
    return _page("equipe.html")


@app.get("/sumup-retour/{foreign_id}", include_in_schema=False)
def sumup_return_page(foreign_id: str):
    return _page("sumup.html")


@app.get("/plan.html", include_in_schema=False)
def plan_page():
    return _page("plan.html")


@app.get("/bilan.html", include_in_schema=False)
def year_report_page():
    return _page("bilan.html")


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
