from __future__ import annotations

import datetime as dt
import hashlib
import json
import asyncio
import base64
import logging
import mimetypes
import re
import secrets
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import auth, db
from .geo import point_in_polys
from .limits import RoadIndex, describe_limit_polys
from . import central, offsite, plateforme, whatsapp
from .models import (AvancementIn, CodeIn, ConfirmIn, DonAnnexeIn, DonIn, DonStatutIn, EquipeIn, ExclusionIn, LoginIn, PersonneIn,
                     PersonnesIn, RemiseIn, RenfortIn, SectorsIn, SettingsIn, StatusUpdate, SumupRetourIn,
                     NoteIn, SignalementIn, SignalementActionIn, EnvoiAccesIn, RoleIn, CompteIn,
                     CompteUpdateIn, MotDePasseIn, DepotIn, ClotureIn, ReouvertureIn,
                     SuperviseurIn, LogementsIn, AdresseCorrectionIn, LogoIn, EntrepriseIn, EntrepriseAjoutIn)
from .resume import build_resume, commune_voie_counts

DATA_DIR = Path(os.environ.get("SECTORS_DATA_DIR") or (Path(__file__).resolve().parent / "data"))


def _data_dir() -> Path:
    """Données des communes : celles de la caserne en cours (multi-casernes), sinon SECTORS_DATA_DIR."""
    cas = plateforme.current.get()
    return Path(cas.data_dir) if cas is not None else DATA_DIR

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


def _each_caserne():
    """Casernes actives pour les tâches de fond (une seule « caserne » hors version multi-casernes)."""
    if not plateforme.enabled():
        return [None]
    return [c for c in plateforme.list_casernes() if c.statut != "archivee"]


async def _daily_backups() -> None:
    """Pour chaque caserne : une sauvegarde de la base par jour (vérifié chaque heure), 30 gardées,
    copie hors du serveur et nettoyage des données arrivées au bout de leur durée de conservation."""
    await asyncio.sleep(60)  # laisse le serveur démarrer
    while True:
        for cas in await asyncio.to_thread(_each_caserne):
            with plateforme.use(cas):
                await _daily_tasks()
        await asyncio.sleep(3600)


async def _daily_tasks() -> None:
    try:
        if not await asyncio.to_thread(db.backup_done_today):
            name = await asyncio.to_thread(db.make_backup)
            log.info("Sauvegarde créée : %s", name)
            await asyncio.to_thread(_offsite_copy, name)
    except Exception:  # une sauvegarde ratée ne doit jamais arrêter le site
        log.exception("Sauvegarde automatique impossible")
    try:
        today = dt.date.today().isoformat()
        if db.get_setting("purge_jour", "") != today:
            await asyncio.to_thread(_purge, "Nettoyage automatique")
            db.set_setting("purge_jour", today)
    except Exception:
        log.exception("Nettoyage des données impossible")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if plateforme.enabled():
        plateforme.init()
    else:
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


# ---- Identité de la caserne (nom, logo, couleur) ------------------------------------------
# Sans réglage, l'installation simple garde exactement l'apparence de Courzieu ; une caserne de la
# plateforme prend son nom et un logo neutre, qu'elle personnalise dans son admin.

DEFAULT_NOM = os.environ.get("CASERNE_NOM") or "Sapeurs-pompiers de Courzieu"
DEFAULT_COULEUR = "#e5383b"
LOGO_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg"}


def _mix(hex_color: str, other: tuple[int, int, int], t: float) -> str:
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return "#" + "".join(f"{round(c + (o - c) * t):02x}" for c, o in zip((r, g, b), other))


def _branding() -> dict:
    cas = plateforme.current.get()
    nom = db.get_setting("caserne_nom", "") or (cas.nom if cas else DEFAULT_NOM)
    couleur = db.get_setting("caserne_couleur", "") or DEFAULT_COULEUR
    logo_v = db.get_setting("caserne_logo_v", "")
    if logo_v:
        logo = f"/logo?v={logo_v}"
    else:
        logo = "/img/logo-generique.svg" if cas is not None else "/img/logo-courzieu.png"
    return {"nom": nom, "couleur": couleur, "logo": logo, "logo_perso": bool(logo_v),
            "communes": [c["nom"] for c in list_communes().get("communes", [])]}


def _theme_css(couleur: str) -> str:
    if couleur.lower() == DEFAULT_COULEUR:
        return ""  # couleurs de la feuille de style
    return (f"<style>:root{{--accent:{couleur};--accent-dark:{_mix(couleur, (0, 0, 0), .14)};"
            f"--accent-soft:{_mix(couleur, (255, 255, 255), .93)}}}</style>")


def _page(name: str, brand: bool = True) -> HTMLResponse:
    """Page HTML dont les liens vers scripts/styles portent la version courante, aux couleurs de la caserne."""
    html = (FRONTEND_DIR / name).read_text(encoding="utf-8").replace("__V__", ASSET_VERSION)
    if brand:
        b = _branding()
        esc = lambda v: v.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")  # noqa: E731
        communes = " &amp; ".join(esc(c) for c in b["communes"])
        own = b["logo_perso"] or plateforme.current.get() is not None  # sinon : icônes de Courzieu
        multi = plateforme.current.get() is not None
        name = esc(plateforme.PLATFORM_NAME)
        html = (html.replace("__PROPULSE__", f'<p class="powered">propulsé par <b>{name}</b></p>' if multi else "")
                .replace("__PLATEFORME__", f'<section><h2 id="ml-plateforme">Application</h2><p>Ce site utilise <b>{name}</b>, '
                         "l'application de tournée des calendriers des sapeurs-pompiers. La caserne reste seule responsable "
                         "de ses données (voir ci-dessus).</p></section>" if multi else ""))
        html = (html.replace("__CASERNE__", esc(b["nom"])).replace("__LOGO__", esc(b["logo"]))
                .replace("__COMMUNES__", communes)
                .replace("__FAVICON__", esc(b["logo"]) if own else "/icons/favicon-64.png")
                .replace("__APPLEICON__", esc(b["logo"]) if own else "/icons/apple-touch-icon.png")
                .replace("__ICON__", esc(b["logo"]) if own else "/icons/icon-192.png"))
        data = json.dumps({"nom": b["nom"], "logo": b["logo"], "couleur": b["couleur"], "communes": b["communes"]},
                          ensure_ascii=False).replace("</", "<\\/")
        html = html.replace("</head>", f"{_theme_css(b['couleur'])}<script>window.CASERNE={data};</script>\n</head>", 1)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

# fichiers produits par le pipeline, rechargés s'ils sont régénérés
_communes_cache: dict[str, dict] = {}


def _load_commune(slug: str) -> dict:
    path = _data_dir() / f"{slug}.json"
    if not slug.replace("-", "").isalnum() or not path.exists():
        raise HTTPException(status_code=404, detail=f"Commune inconnue: {slug}")
    mtime = str(path.stat().st_mtime)
    key = str(path)  # une entrée par caserne et par commune
    cached = _communes_cache.get(key)
    if cached and cached["_mtime"] == mtime:
        return cached
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    data["_mtime"] = mtime
    data["_address_ids"] = {a["id"] for a in data["addresses"]}
    _communes_cache[key] = data
    return data


def _addresses(slug: str, data: dict) -> list[dict]:
    """Adresses de la commune : Base Adresse + maisons ajoutées par l'admin, avec les corrections
    de l'admin (numéro, rue, position)."""
    out = _base_and_added(slug, data)
    fixes = db.list_corrections(slug)
    if fixes:
        out = [_corrected(a, fixes[a["id"]]) if a["id"] in fixes else a for a in out]
    ents = db.list_entreprises(slug)
    if ents:
        out = [{**a, "entreprise": ents[a["id"]]["nom"] or "Entreprise"} if a["id"] in ents else a for a in out]
    return out


def _corrected(a: dict, fix: dict) -> dict:
    """Adresse corrigée : même identifiant (l'historique suit), nouveau numéro / rue / position.
    L'adresse d'origine reste jointe pour pouvoir revenir en arrière."""
    numero, voie = fix["numero"], fix["nom_voie"]
    same_num = numero == a.get("numero", "")
    rep = a.get("rep", "") if same_num else ""  # « 12 bis » : on peut aussi taper « 12 bis » comme numéro
    label = " ".join(x for x in (numero, rep, voie) if x) or a["label"]
    return {**a, "numero": numero, "rep": rep, "nom_voie": voie, "label": label,
            "lat": fix["lat"], "lon": fix["lon"], "corrigee": True,
            "origine": {"label": a["label"], "numero": a.get("numero", ""), "nom_voie": a.get("nom_voie", ""), "lat": a["lat"], "lon": a["lon"]}}


def _base_and_added(slug: str, data: dict) -> list[dict]:
    """Base Adresse + maisons ajoutées par l'admin. Une maison ajoutée prend le hameau (groupe)
    de l'adresse connue la plus proche."""
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


ENT_BOX = 0.00018  # demi-côté (≈ 20 m) du carré tracé autour de chaque entreprise sur les cartes


def _sectors(slug: str, data: dict, kind: str | None = None) -> list[dict]:
    """Secteurs de la commune. La tournée des entreprises n'a pas de tracé : elle prend les adresses
    marquées « entreprise » (prioritaires sur les secteurs dessinés) et, pour les cartes, un petit carré
    autour de chacune. Une adresse retirée des entreprises retombe dans le secteur dessiné qui la contient."""
    sectors = db.list_sectors(slug, kind)
    for s in sectors:
        if s["kind"] != "entreprises":
            continue
        ents = db.list_entreprises(slug)
        excluded = db.get_excluded(slug)
        pts = [a for a in _addresses(slug, data) if a["id"] in ents and a["id"] not in excluded]
        s["ids"] = {a["id"] for a in pts}
        if not pts:  # tournée vide : un carré à la mairie, pour que les cartes restent lisibles
            m = data["commune"].get("mairie") or {"lat": data["addresses"][0]["lat"], "lon": data["addresses"][0]["lon"]}
            pts = [m]
        d = ENT_BOX
        s["polygon"] = [[[[p["lat"] - d, p["lon"] - d * 1.4], [p["lat"] - d, p["lon"] + d * 1.4],
                          [p["lat"] + d, p["lon"] + d * 1.4], [p["lat"] + d, p["lon"] - d * 1.4]]] for p in pts]
    return sectors


def _sectors_with_limits(slug: str, data: dict, kind: str | None = None) -> list[dict]:
    """Secteurs enregistrés, avec la description de leur limite (recalculée si
    le tracé ou les données de la commune ont changé)."""
    sectors = _sectors(slug, data, kind)
    for s in sectors:  # (la tournée des entreprises garde ses « ids » : à retirer avant de renvoyer la réponse)
        if s["kind"] == "entreprises":
            s["limite"] = None
        elif s["limite_src"] != data["_mtime"]:
            s["limite"] = describe_limit_polys(s["polygon"], _road_index(data))
            db.set_sector_limite(s["id"], s["limite"], data["_mtime"])
        s.pop("limite_src", None)
    return sectors


def _assign(addresses: list[dict], sectors: list[dict]) -> tuple[dict[int, list[dict]], list[dict]]:
    """Affecte chaque adresse au premier secteur (dans l'ordre) qui la contient."""
    by_sector: dict[int, list[dict]] = {s["id"]: [] for s in sectors}
    outside = []
    ent = next((s for s in sectors if s.get("kind") == "entreprises"), None)
    ent_ids = ent.get("ids", set()) if ent else set()
    for addr in addresses:
        if addr["id"] in ent_ids:  # entreprise : dans sa tournée, quel que soit le secteur dessiné
            by_sector[ent["id"]].append(addr)
            continue
        for s in sectors:
            if s.get("kind") == "entreprises":
                continue
            if point_in_polys(addr["lat"], addr["lon"], s["polygon"]):
                by_sector[s["id"]].append(addr)
                break
        else:
            outside.append(addr)
    return by_sector, outside


def _avancement() -> str:
    """Ce qui compte dans le pourcentage d'avancement : « passees » (faites, refus et absents à repasser),
    « terminees » (faites et refus : les absents restent à faire) ou « faites » (seulement les maisons faites)."""
    v = db.get_setting("avancement", "") or "passees"
    return v if v in ("passees", "terminees", "faites") else "passees"


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


def _check_open(annee: int) -> None:
    """Les montants d'une année clôturée ne bougent plus (dossier comptable figé)."""
    if db.active_cloture(annee):
        raise HTTPException(status_code=409, detail=f"La tournée {annee} est clôturée : les dons et la caisse ne peuvent plus être modifiés")


@app.get("/api/communes")
def list_communes():
    index_path = _data_dir() / "index.json"
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
        addresses = [{k: a.get(k, "") for k in ("id", "label", "groupe", "nom_voie", "numero", "lat", "lon", "entreprise")} for a in mine]
        sector = {**{k: v for k, v in s.items() if k != "ids"}, "addresses": addresses, "resume": build_resume(mine, voie_counts)}
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
    sector_id, moved = _sector_for_action(request, slug, address_id, payload.sector_id, payload.fait_le)
    n = db.get_units(slug).get(address_id, 1)
    if payload.logement and payload.logement > n:
        raise HTTPException(status_code=422, detail=f"Cet immeuble a {n} logement(s)")
    before = (db.get_statuses(slug).get(address_id) or {}).get("status")
    unit_before = (db.get_unit_statuses(slug).get(address_id, {}).get(payload.logement) or {}).get("status") if payload.logement else None
    result = _mark(slug, address_id, payload.status, _actor(request)[0], payload.logement, payload.note)
    where = f"{_sector_label(sector_id)} · {_addr_label(slug, address_id)}" + (" · maison passée depuis dans un autre secteur" if moved else "")
    if n > 1 and payload.logement:
        if unit_before != payload.status:
            _log(request, "statut", f"{where} · {_unit_name(slug, address_id, payload.logement)}",
                 f"{STATUS_FR.get(unit_before, unit_before)} → {STATUS_FR.get(payload.status, payload.status)}"
                 f" (immeuble : {STATUS_FR.get(result['status'], result['status'])})")
    elif before != payload.status or n > 1:
        _log(request, "statut", where, f"{STATUS_FR.get(before, before)} → {STATUS_FR.get(payload.status, payload.status)}"
             + (f" (les {n} logements)" if n > 1 else ""))
    return result


def _mark(slug: str, address_id: str, status: str | None, par: str, logement: int | None = None, note: str | None = None) -> dict:
    """Pose un statut. Pour un immeuble, sur un logement (ou tous si aucun n'est précisé) ;
    l'adresse n'est « faite » que lorsque tous ses logements sont passés."""
    n = db.get_units(slug).get(address_id, 1)
    if n <= 1:
        return db.set_status(slug, address_id, status, note, par)
    for lg in ([logement] if logement else range(1, n + 1)):
        db.set_unit_status(slug, address_id, lg, status, par)
    units = db.get_unit_statuses(slug).get(address_id, {})
    result = db.set_status(slug, address_id, db.building_status(n, units), note, par)
    result["logements"] = {"n": n, "units": {str(k): v for k, v in units.items() if k <= n}}
    return result


def _don_marks_done(don: dict, par: str) -> None:
    """Un don payé veut dire que la maison est faite ; dans un immeuble, seulement son logement."""
    n = db.get_units(don["commune_slug"]).get(don["address_id"], 1)
    if n > 1 and not don.get("logement"):
        return  # logement inconnu : on ne marque pas tout l'immeuble « fait » à tort
    _mark(don["commune_slug"], don["address_id"], "fait", par, don.get("logement") if n > 1 else None)


# ---- Accès des équipes (code personnel) --------------------------------------------

def _sector_map(slug: str) -> tuple[dict, list[dict], dict[int, list[dict]]]:
    data = _load_commune(slug)
    sectors = _sectors(slug, data)
    by_sector, _ = _assign(_active_addresses(slug, data), sectors)
    return data, sectors, by_sector


def _all_slugs() -> list[str]:
    """Toutes les communes : celles du site (index.json) et celles qui ont des secteurs."""
    slugs: list[str] = []
    index_path = _data_dir() / "index.json"
    if index_path.exists():
        with open(index_path, "r", encoding="utf-8") as fh:
            slugs = [c["slug"] for c in json.load(fh).get("communes", []) if (_data_dir() / f"{c['slug']}.json").exists()]
    return slugs + [s for s in db.sector_communes() if s not in slugs]


def _tours() -> list[dict]:
    """Chaque tournée une seule fois, même la tournée des entreprises qui couvre plusieurs communes :
    {"sector", "slugs", "commune" (noms), "addrs": [(slug, adresse)], "polygon"}."""
    out: dict[int, dict] = {}
    for slug in _all_slugs():
        data, sectors, by_sector = _sector_map(slug)
        nom = data["commune"]["nom"]
        for s in sectors:
            t = out.get(s["id"])
            if t is None:
                t = out[s["id"]] = {"sector": s, "slugs": [], "communes": [], "addrs": [], "polygon": []}
            t["slugs"].append(slug)
            t["communes"].append(nom)
            t["addrs"].extend((slug, a) for a in by_sector.get(s["id"], []))
            t["polygon"].extend(s["polygon"])
    for t in out.values():
        t["commune"] = " + ".join(t["communes"])
        t["slug"] = t["slugs"][0]
    # secteurs des communes dans l'ordre, puis les tournées communes (entreprises)
    return sorted(out.values(), key=lambda t: (t["sector"]["kind"] != "secteur",))


def _sector_slugs(sector_id: int) -> list[str]:
    """Communes couvertes par une tournée (plusieurs pour la tournée des entreprises)."""
    return [slug for slug in _all_slugs() if any(s["id"] == sector_id for s in db.list_sectors(slug))]


def _sector_of_address(slug: str, address_id: str) -> int:
    data, _, by_sector = _sector_map(slug)
    if address_id not in _address_ids(slug, data):
        raise HTTPException(status_code=404, detail="Adresse inconnue")
    for sector_id, addresses in by_sector.items():
        if any(a["id"] == address_id for a in addresses):
            return sector_id
    raise HTTPException(status_code=404, detail="Adresse hors secteur")


RETARD_TOLERE = dt.timedelta(minutes=15)   # liste pas encore rafraîchie sur le téléphone
HORS_RESEAU_MAX = dt.timedelta(days=7)      # au-delà, un envoi en attente n'est plus accepté


def _sectors_at(slug: str, address_id: str, fait_le: dt.datetime | None) -> list[int]:
    """Secteurs où se trouvait la maison au moment du geste (ou dans le quart d'heure avant)."""
    now = dt.datetime.now(dt.timezone.utc)
    when = now if fait_le is None else (fait_le if fait_le.tzinfo else fait_le.replace(tzinfo=dt.timezone.utc))
    when = min(when, now)
    if now - when > HORS_RESEAU_MAX:
        return []
    addr = next((a for a in _active_addresses(slug, _load_commune(slug)) if a["id"] == address_id), None)
    if not addr:
        return []
    iso = lambda t: t.astimezone(dt.timezone.utc).isoformat(timespec="microseconds")
    found: list[int] = []
    for sectors in db.versions_between(slug, iso(when - RETARD_TOLERE), iso(when)):
        sid = next((s["id"] for s in sectors if s.get("kind", "secteur") == "secteur" and point_in_polys(addr["lat"], addr["lon"], s["polygon"])), None)
        if sid is not None and sid not in found:
            found.append(sid)
    return found


def _sector_for_action(request: Request, slug: str, address_id: str,
                       hint: int | None = None, fait_le: dt.datetime | None = None) -> tuple[int, bool]:
    """Secteur au titre duquel l'équipe agit sur une maison, et s'il a changé depuis.
    Normalement celui où est la maison aujourd'hui. Si l'admin a modifié les secteurs entre-temps
    (téléphone hors réseau, liste pas encore rafraîchie), le geste reste accepté pour l'équipe
    du secteur où était la maison au moment où il a été fait."""
    try:
        current = _sector_of_address(slug, address_id)
    except HTTPException as err:
        if err.detail != "Adresse hors secteur":
            raise
        current = None
    if current is not None and _role(request, current):
        return current, False
    past = _sectors_at(slug, address_id, fait_le)
    if hint in past:
        past.remove(hint)
        past.insert(0, hint)
    existing = {s["id"] for s in db.list_sectors(slug)}
    for sid in past:
        if sid != current and sid in existing and _role(request, sid):
            return sid, True
    if current is None:
        raise HTTPException(status_code=404, detail="Adresse hors secteur")
    _require_role(request, current)
    return current, False


def _role(request: Request, sector_id: int) -> str | None:
    """Rôle de la personne connectée sur un secteur : admin, responsable, superviseur, equipier ou None.
    Un superviseur a les droits d'un responsable sur toutes les tournées, sans figurer dans les équipes."""
    if auth.is_admin(request):
        return "admin"
    person = auth.team_member(request)
    if not person:
        return None
    role = db.memberships(person["id"]).get(sector_id)
    if person.get("superviseur") and role != "responsable":
        return "superviseur"
    return role


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
    ip = auth.client_ip(request)
    if auth.too_many_attempts(ip):
        raise HTTPException(status_code=429, detail="Trop d'essais : réessayez dans quelques minutes")
    person = db.get_personne_by_code(payload.code)
    if not person:
        auth.record_failure(ip)
        time.sleep(1)  # ralentit les essais en série
        raise HTTPException(status_code=401, detail="Code inconnu")
    db.touch_personnes([person["id"]])
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
    superviseur = bool(person and person.get("superviseur"))
    if superviseur:
        roles = {sid: roles.get(sid) if roles.get(sid) == "responsable" else "superviseur" for sid in sorted(db.existing_sector_ids())}
    return {
        "admin": admin,
        "superviseur": superviseur,
        "personne": {"id": person["id"], "nom": person["nom"]} if person else None,
        "secteurs": [{"sector_id": sid, "role": role} for sid, role in roles.items()],
        "suivi": _suivi_enabled(),
        "dons": _suivi_enabled() and _flag("dons_actifs", False),
        "sumup": _sumup_config(),
        "recus": _flag("recus_actifs", True),
        "avancement": _avancement(),
    }


def _don_view(d: dict, full: bool, me: int | None) -> dict:
    mine = me is not None and d["personne_id"] == me
    view = {k: d[k] for k in ("id", "address_id", "mode", "statut", "note", "personne_nom", "created_at", "logement")}
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
    slugs = _sector_slugs(sector_id)
    if not slugs:
        raise HTTPException(status_code=404, detail="Secteur inconnu")
    full = role in ("admin", "responsable", "superviseur")
    person = auth.team_member(request)
    me = person["id"] if person else None
    out = {"slug": slugs[0], "slugs": slugs, "role": role, "statuses": {}, "dons": None, "totaux": None, "precedent": {},
           "equipe": _team_view(sector_id), "notes": {}, "logements": {},
           "signalements": [_sig_view(x) for x in db.list_signalements(sector_id, open_only=True)]}
    all_ids: set[str] = set()
    # une tournée peut couvrir plusieurs communes (entreprises) : les identifiants d'adresse sont uniques
    for slug in slugs:
        _, _, by_sector = _sector_map(slug)
        ids = {a["id"] for a in by_sector.get(sector_id, [])}
        all_ids |= ids
        out["statuses"].update({aid: st for aid, st in db.get_statuses(slug).items() if aid in ids and st.get("status")})
        out["notes"].update({aid: n for aid, n in db.get_notes(slug).items() if aid in ids})
        out["logements"].update(_logements(slug, ids))
        for aid, prev in db.previous_year(slug, _annee()).items():
            if aid in ids:
                item = {"annee": prev["annee"], "status": prev["status"], "nb_dons": prev["nb_dons"]}
                if full:
                    item["montant"] = prev["montant_cents"] / 100
                out["precedent"][aid] = item
    ids = all_ids
    if _flag("dons_actifs", False):
        dons = db.list_dons(_annee(), sector_id)
        out["dons"] = [_don_view(d, full, me) for d in dons]
        if full:
            out["totaux"] = _totaux(dons)
        out["dons_autres"] = _dons_autres(sector_id, ids, full, me)
    return out


def _dons_autres(sector_id: int, ids: set[str], full: bool, me: int | None) -> dict[str, list[dict]]:
    """Dons déjà reçus pour des maisons du secteur par une autre équipe (la maison a changé
    de secteur depuis) : affichés pour information, ils restent dans la caisse de cette équipe."""
    out: dict[str, list[dict]] = {}
    labels = None
    for d in db.list_dons(_annee()):
        if d["address_id"] not in ids or d["sector_id"] == sector_id or d["statut"] == "echec":
            continue
        labels = labels or _sector_labels()
        view = _don_view(d, full, me)
        view.pop("tx_code", None)
        view["secteur"] = labels.get(d["sector_id"], "secteur supprimé")
        out.setdefault(d["address_id"], []).append(view)
    return out


def _logements(slug: str, ids: set[str]) -> dict:
    """Immeubles du secteur : nombre de logements et statut de chacun (cette année)."""
    units = db.get_units(slug)
    statuses = db.get_unit_statuses(slug)
    labels = db.get_unit_labels(slug)
    return {aid: {"n": n, "units": {str(k): v for k, v in statuses.get(aid, {}).items() if k <= n},
                  "libelles": {str(k): v for k, v in labels.get(aid, {}).items() if k <= n}}
            for aid, n in units.items() if aid in ids}


def _unit_name(slug: str, address_id: str, logement: int) -> str:
    lib = db.get_unit_labels(slug).get(address_id, {}).get(logement)
    return f"logement {logement}" + (f" ({lib})" if lib else "")


@app.post("/api/equipe/logements")
def team_set_units(payload: LogementsIn, request: Request):
    """Indique qu'une adresse est un immeuble de N logements (1 = maison individuelle)."""
    sector_id, _ = _sector_for_action(request, payload.slug, payload.address_id, payload.sector_id, payload.fait_le)
    before = db.get_units(payload.slug).get(payload.address_id, 1)
    db.set_units(payload.slug, payload.address_id, payload.logements)
    old_labels = db.get_unit_labels(payload.slug).get(payload.address_id, {})
    renamed = []
    for lg, lib in payload.libelles.items():
        if lg <= payload.logements and old_labels.get(lg, "") != lib:
            db.set_unit_label(payload.slug, payload.address_id, lg, lib)
            renamed.append(f"logement {lg} : {old_labels.get(lg) or '—'} → {lib or '—'}")
    par = _actor(request)[0]
    if payload.logements > 1:
        # l'immeuble reprend le statut calculé d'après ses logements (une adresse marquée « faite »
        # d'un seul coup redevient « à faire » tant que tous les logements ne sont pas passés)
        units = db.get_unit_statuses(payload.slug).get(payload.address_id, {})
        db.set_status(payload.slug, payload.address_id, db.building_status(payload.logements, units), None, par)
    if before != payload.logements or renamed:
        _log(request, "immeuble", f"{_sector_label(sector_id)} · {_addr_label(payload.slug, payload.address_id)}",
             " · ".join(([f"{before} → {payload.logements} logement(s)"] if before != payload.logements else []) + renamed))
    status = (db.get_statuses(payload.slug).get(payload.address_id) or {}).get("status")
    return {"address_id": payload.address_id, "status": status,
            "logements": _logements(payload.slug, {payload.address_id}).get(payload.address_id, {"n": 1, "units": {}, "libelles": {}})}


@app.post("/api/equipe/dons")
def team_add_don(payload: DonIn, request: Request):
    if not (_suivi_enabled() and _flag("dons_actifs", False)):
        raise HTTPException(status_code=403, detail="L'enregistrement des dons est désactivé")
    # le don revient à l'équipe qui l'a reçu (c'est elle qui a l'argent), même si la maison
    # a changé de secteur pendant que le téléphone était hors réseau
    sector_id, moved = _sector_for_action(request, payload.slug, payload.address_id, payload.sector_id, payload.fait_le)
    _check_open(_annee())
    person = auth.team_member(request)
    use_sumup = payload.mode == "cb" and payload.sumup
    if use_sumup and not _sumup_config():
        raise HTTPException(status_code=409, detail="Le paiement SumUp n'est pas configuré")
    n = db.get_units(payload.slug).get(payload.address_id, 1)
    logement = payload.logement if n > 1 else None
    if logement and logement > n:
        raise HTTPException(status_code=422, detail=f"Cet immeuble a {n} logement(s)")
    don, created = db.add_don({
        "annee": _annee(), "commune_slug": payload.slug, "address_id": payload.address_id, "sector_id": sector_id,
        "montant_cents": round(payload.montant * 100), "mode": payload.mode,
        "statut": "attente" if use_sumup else "ok",
        "foreign_id": f"cal-{secrets.token_hex(12)}" if use_sumup else None,
        "tx_code": payload.tx_code, "note": payload.note,
        "personne_id": person["id"] if person else None, "personne_nom": person["nom"] if person else _actor(request)[0],
        "client_id": payload.client_id, "logement": logement,
    })
    if created:
        _log(request, "don.ajout", f"{_sector_label(sector_id)} · {_addr_label(payload.slug, payload.address_id)}"
             + (f" · {_unit_name(payload.slug, payload.address_id, logement)}" if logement else "") + (" · maison passée depuis dans un autre secteur" if moved else ""),
             f"{_euros(don['montant_cents'])} {MODE_FR[don['mode']]}{' (SumUp, en attente)' if use_sumup else ''}")
    # un don reçu veut dire que la maison est faite (paiement carte : une fois confirmé)
    if created and don["statut"] == "ok":
        _don_marks_done(don, _actor(request)[0])
    view = _don_view(don, True, None)
    view["foreign_id"] = don["foreign_id"]
    return view


def _don_for_edit(request: Request, don_id: int) -> dict:
    don = db.get_don(don_id)
    if not don or don["annule_le"]:
        raise HTTPException(status_code=404, detail="Don inconnu")
    _check_open(don["annee"])
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
        _don_marks_done(updated, _actor(request)[0])
    _log(request, "don.statut", f"{_sector_label(don['sector_id'])} · {_addr_label(don['commune_slug'], don['address_id'])}",
         f"{_euros(don['montant_cents'])} {MODE_FR[don['mode']]} : {'payé' if payload.statut == 'ok' else 'non payé'}"
         f"{' · n° ' + payload.tx_code if payload.tx_code else ''} (saisi par {don['personne_nom']})")
    return _don_view(updated, True, None)


@app.delete("/api/equipe/dons/{don_id}")
def team_delete_don(don_id: int, request: Request, motif: str = ""):
    """Annule un don (erreur de saisie…) : il ne compte plus mais reste dans le registre, avec le motif."""
    don = _don_for_edit(request, don_id)
    motif = " ".join(motif.split())[:200] or "annulé sans motif"
    db.cancel_don(don["id"], _actor(request)[0], motif)
    _log(request, "don.suppression", f"{_sector_label(don['sector_id'])} · {_addr_label(don['commune_slug'], don['address_id'])}",
         f"n° {don['numero']} · {_euros(don['montant_cents'])} {MODE_FR[don['mode']]} (saisi par {don['personne_nom']}) · motif : {motif}")
    return {"ok": True}


@app.get("/api/equipe/apercu")
def team_overview(request: Request):
    """Toutes les tournées d'un coup d'œil (superviseur ou administrateur) : avancement et dons par secteur."""
    person = auth.team_member(request)
    if not auth.is_admin(request) and not (person and person.get("superviseur")):
        if not person:
            raise HTTPException(status_code=401, detail="Connectez-vous avec votre code d'équipe")
        raise HTTPException(status_code=403, detail="Réservé aux superviseurs")
    labels = _sector_labels()
    teams = db.get_teams()
    people = {p["id"]: p["nom"] for p in db.list_personnes()}
    dons_on = _suivi_enabled() and _flag("dons_actifs", False)
    dons = db.list_dons(_annee()) if dons_on else []
    out = []
    statuses_of = {slug: (db.get_statuses(slug) if _suivi_enabled() else {}) for slug in _all_slugs()}
    for t in _tours():
        s, slug = t["sector"], t["slug"]
        ids = [a["id"] for _, a in t["addrs"]]
        c = {"fait": 0, "absent": 0, "refus": 0}
        for sl, a in t["addrs"]:
            st = (statuses_of[sl].get(a["id"]) or {}).get("status")
            if st in c:
                c[st] += 1
        team = teams.get(s["id"]) or {"date": "", "creneau": "", "statut": "a_faire", "membres": []}
        mine = [d for d in dons if d["sector_id"] == s["id"] and d["statut"] == "ok"]
        out.append({"sector_id": s["id"], "slug": slug, "secteur": labels.get(s["id"], s["nom"]), "couleur": s["couleur"],
                    "adresses": len(ids), **c, "statut": team["statut"], "date": team["date"], "creneau": team["creneau"],
                    "responsables": [people[m["personne_id"]] for m in team["membres"] if m["role"] == "responsable" and m["personne_id"] in people],
                    "dons": ({"nb": len(mine), "total": sum(d["montant_cents"] for d in mine) / 100} if dons_on else None)})
    return {"secteurs": out, "suivi": _suivi_enabled()}


# ---- Reçus de paiement (non fiscaux) ------------------------------------------------------

@app.post("/api/equipe/dons/{don_id}/recu")
def team_receipt(don_id: int, request: Request):
    """Lien du reçu de paiement d'un don, à montrer en QR code ou à envoyer à l'habitant."""
    if not _flag("recus_actifs", True):
        raise HTTPException(status_code=403, detail="Les reçus sont désactivés")
    don = db.get_don(don_id)
    if not don:
        raise HTTPException(status_code=404, detail="Don inconnu")
    role = _require_role(request, don["sector_id"])
    person = auth.team_member(request)
    if role == "equipier" and not (person and don["personne_id"] == person["id"]):
        raise HTTPException(status_code=403, detail="Seul le responsable du secteur ou la personne qui a saisi le don peut faire le reçu")
    token = db.don_receipt_token(don_id)
    return {"token": token, "url": f"/recu/{token}"}


@app.get("/api/recu/{token}")
def public_receipt(token: str):
    """Reçu de paiement (public, par son lien secret) : sans adresse ni nom de l'habitant."""
    don = db.get_don_by_receipt(token) if re.fullmatch(r"[A-Za-z0-9_-]{16,40}", token) else None
    if not don:
        raise HTTPException(status_code=404, detail="Reçu introuvable")
    asso = {k: db.get_setting(f"asso_{k}", "") or "" for k in ("nom", "adresse", "siret")}
    return {
        "association": asso, "annee": don["annee"], "numero": don["numero"], "date": don["created_at"],
        "montant": don["montant_cents"] / 100, "mode": MODE_FR[don["mode"]],
        "statut": "annule" if don["annule_le"] else don["statut"],
        "collecteur": (don["personne_nom"] or "").split(" ")[0],
        "reference": don["tx_code"] if don["mode"] == "cb" else "",
    }


@app.get("/api/public/mentions")
def public_legal():
    """Éditeur, hébergeur, contact et durées de conservation, pour la page des mentions légales."""
    return {
        "association": {k: db.get_setting(f"asso_{k}", "") or "" for k in ("nom", "adresse", "siret")},
        **{k: db.get_setting(k, "") or "" for k in ("editeur", "contact_email", "contact_tel", "hebergeur")},
        "conservation": {k: float(db.get_setting(k, "") or d) for k, d in RETENTION_DEFAULTS.items()},
        "suivi": _suivi_enabled(), "dons": _suivi_enabled() and _flag("dons_actifs", False),
        "telephones_public": _flag("telephones_public", False), "equipes_public": _flag("equipes_public", True),
    }


# ---- Notes et signalements des équipes ------------------------------------------------

def _person_name(request: Request) -> str:
    person = auth.team_member(request)
    return person["nom"] if person else "Admin"


@app.post("/api/equipe/notes")
def team_set_note(payload: NoteIn, request: Request):
    """Note de l'équipe sur une maison (vide = effacée), gardée d'une année sur l'autre."""
    if not _suivi_enabled():
        raise HTTPException(status_code=403, detail="Le suivi des adresses est désactivé")
    sector_id, _ = _sector_for_action(request, payload.slug, payload.address_id, payload.sector_id, payload.fait_le)
    _log(request, "note", f"{_sector_label(sector_id)} · {_addr_label(payload.slug, payload.address_id)}", payload.note or "note effacée")
    return {"note": db.set_note(payload.slug, payload.address_id, payload.note, _person_name(request))}


def _sig_view(x: dict) -> dict:
    return {k: x[k] for k in ("id", "type", "address_id", "lat", "lon", "numero", "nom_voie", "note",
                              "personne_nom", "statut", "created_at", "entreprise")}


@app.post("/api/equipe/signalements")
def team_report(payload: SignalementIn, request: Request):
    """Maison manquante, vide ou démolie, adresse fausse… vue sur le terrain ; l'admin tranche."""
    if payload.type == "manquante":
        sector_id = payload.sector_id
        if sector_id not in {s["id"] for s in db.list_sectors(payload.slug)}:
            raise HTTPException(status_code=404, detail="Secteur inconnu")
        _require_role(request, sector_id)
    else:
        sector_id, _ = _sector_for_action(request, payload.slug, payload.address_id, payload.sector_id, payload.fait_le)
    sig = db.add_signalement({**payload.model_dump(exclude={"slug", "sector_id", "fait_le"}), "commune_slug": payload.slug,
                              "sector_id": sector_id, "personne_nom": _person_name(request)})
    where = _addr_label(payload.slug, payload.address_id) if payload.address_id else " ".join(x for x in (payload.numero, payload.nom_voie) if x) or "position sur la carte"
    _log(request, "signalement", f"{_sector_label(sector_id)} · {where}", f"{payload.type}"
         + (f" · entreprise « {payload.entreprise} »" if payload.entreprise else " · entreprise" if payload.entreprise is not None else "")
         + (f" · {payload.note}" if payload.note else ""))
    return _sig_view(sig)


@app.get("/api/admin/signalements", dependencies=[Depends(auth.require("suivi"))])
def admin_reports():
    labels: dict[str, dict] = {}
    for slug in _all_slugs():
        for a in _addresses(slug, _load_commune(slug)):
            labels[f"{slug}/{a['id']}"] = a
    sectors = {s["id"]: s["nom"] for slug in _all_slugs() for s in db.list_sectors(slug)}
    excluded = {slug: db.get_excluded(slug) for slug in _all_slugs()}
    out = []
    for x in db.list_signalements():
        a = labels.get(f"{x['commune_slug']}/{x['address_id']}") if x["address_id"] else None
        out.append({**_sig_view(x), "slug": x["commune_slug"], "sector_id": x["sector_id"],
                    "secteur": sectors.get(x["sector_id"], ""), "adresse": a["label"] if a else "",
                    "numero_actuel": " ".join(v for v in ((a or {}).get("numero", ""), (a or {}).get("rep", "")) if v),
                    "voie_actuelle": (a or {}).get("nom_voie", "") or (a or {}).get("lieu_dit", ""),
                    "corrigee": bool(a and a.get("corrigee")),
                    "deja_entreprise": (a or {}).get("entreprise"),
                    "lat": x["lat"] if x["lat"] is not None else (a or {}).get("lat"),
                    "lon": x["lon"] if x["lon"] is not None else (a or {}).get("lon"),
                    "exclue": bool(a and a["id"] in excluded.get(x["commune_slug"], set())),
                    "traite_le": x["traite_le"]})
    return {"signalements": out}


@app.post("/api/admin/signalements/{sig_id}", dependencies=[Depends(auth.require("suivi"))])
def admin_handle_report(sig_id: int, payload: SignalementActionIn, request: Request):
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
        nom = payload.entreprise if payload.entreprise is not None else sig["entreprise"]
        if nom is not None:  # maison manquante signalée comme entreprise : directement dans la tournée des entreprises
            _set_entreprise(request, sig["commune_slug"], added, nom)
    elif payload.action == "entreprise":
        if not sig["address_id"]:
            raise HTTPException(status_code=409, detail="Aucune adresse")
        _set_entreprise(request, sig["commune_slug"], sig["address_id"],
                        payload.entreprise if payload.entreprise is not None else (sig["entreprise"] or ""))
    elif payload.action == "corriger":
        if not sig["address_id"]:
            raise HTTPException(status_code=409, detail="Aucune adresse à corriger")
        if not payload.nom_voie:
            raise HTTPException(status_code=422, detail="Indiquez la rue ou le lieu-dit")
        _correct_address(request, sig["commune_slug"], sig["address_id"], payload.numero, payload.nom_voie)
    elif payload.action == "exclure":
        if not sig["address_id"]:
            raise HTTPException(status_code=409, detail="Aucune adresse à exclure")
        db.set_excluded(sig["commune_slug"], [sig["address_id"]], True)
    statut = {"rouvrir": "nouveau", "ignore": "ignore"}.get(payload.action, "traite")
    where = _addr_label(sig["commune_slug"], sig["address_id"]) if sig["address_id"] else " ".join(x for x in (payload.numero or sig["numero"], payload.nom_voie or sig["nom_voie"]) if x)
    _log(request, "signalement.traite", f"{_sector_label(sig['sector_id'])} · {where}",
         {"ajouter": "maison ajoutée", "exclure": "adresse exclue", "corriger": "adresse corrigée", "entreprise": "ajoutée à la tournée des entreprises", "traite": "marqué traité", "ignore": "ignoré", "rouvrir": "rouvert"}[payload.action]
         + f" (signalé par {sig['personne_nom']})")
    return {**_sig_view(db.set_signalement_statut(sig_id, statut)), "adresse_ajoutee": added}


# ---- Tournée des entreprises -------------------------------------------------------------

def _where_now(slug: str, address_id: str) -> str:
    try:
        return _sector_label(_sector_of_address(slug, address_id))
    except HTTPException:
        return "hors secteur"


def _set_entreprise(request: Request, slug: str, address_id: str, nom: str) -> dict:
    """Passe une adresse à la tournée des entreprises (créée au besoin). Statut, note et dons la suivent."""
    data = _load_commune(slug)
    if address_id not in _address_ids(slug, data):
        raise HTTPException(status_code=404, detail="Adresse inconnue")
    before = _where_now(slug, address_id)
    was = db.list_entreprises(slug).get(address_id)
    db.entreprise_sector(create=True)
    db.set_entreprise(slug, address_id, nom, _actor(request)[0])
    label = _addr_label(slug, address_id)
    if was:
        if was["nom"] != nom:
            _log(request, "entreprise.renommee", label, f"{was['nom'] or 'sans nom'} → {nom or 'sans nom'}")
    else:
        _log(request, "entreprise.ajout", label, f"{before} → {_where_now(slug, address_id)}")
    return next(a for a in _addresses(slug, data) if a["id"] == address_id)


def _unset_entreprise(request: Request, slug: str, address_id: str) -> dict:
    """Retire une adresse de la tournée des entreprises : elle retourne dans le secteur dessiné qui la contient."""
    data = _load_commune(slug)
    ent = db.list_entreprises(slug).get(address_id)
    if not ent:
        raise HTTPException(status_code=404, detail="Cette adresse n'est pas dans la tournée des entreprises")
    label = _addr_label(slug, address_id)
    db.delete_entreprise(slug, address_id)
    _log(request, "entreprise.retrait", label, f"retour dans {_where_now(slug, address_id)}")
    return next(a for a in _addresses(slug, data) if a["id"] == address_id)


@app.put("/api/admin/communes/{slug}/addresses/{address_id}/entreprise", dependencies=[Depends(auth.require("secteurs", "suivi"))])
def admin_set_entreprise(slug: str, address_id: str, payload: EntrepriseIn, request: Request):
    return _set_entreprise(request, slug, address_id, payload.nom)


@app.delete("/api/admin/communes/{slug}/addresses/{address_id}/entreprise", dependencies=[Depends(auth.require("secteurs", "suivi"))])
def admin_unset_entreprise(slug: str, address_id: str, request: Request):
    return _unset_entreprise(request, slug, address_id)


@app.post("/api/admin/communes/{slug}/entreprises", dependencies=[Depends(auth.require("secteurs", "suivi"))])
def admin_add_entreprise(slug: str, payload: EntrepriseAjoutIn, request: Request):
    """Entreprise absente de la Base Adresse (zone artisanale…) : placée sur la carte, dans la tournée des entreprises."""
    data = _load_commune(slug)
    aid = db.add_address(slug, payload.numero, payload.nom_voie, payload.lat, payload.lon)
    _log(request, "adresse.ajoutee", data["commune"]["nom"], " ".join(x for x in (payload.numero, payload.nom_voie) if x))
    return _set_entreprise(request, slug, aid, payload.nom)


# ---- Correction d'une adresse fausse ----------------------------------------------------

def _distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math
    k = math.pi / 180
    x = (lon2 - lon1) * k * math.cos((lat1 + lat2) / 2 * k)
    return math.hypot(x, (lat2 - lat1) * k) * 6371000


def _correct_address(request: Request, slug: str, address_id: str, numero: str, nom_voie: str,
                     lat: float | None = None, lon: float | None = None) -> dict:
    """Corrige numéro / rue / position d'une adresse. Même identifiant : statut, note, logements
    et dons restent attachés à la maison. Revenir exactement à l'origine efface la correction."""
    data = _load_commune(slug)
    a = next((x for x in _addresses(slug, data) if x["id"] == address_id), None)
    if not a:
        raise HTTPException(status_code=404, detail="Adresse inconnue")
    orig = a.get("origine") or a
    if a.get("rep") and numero == f"{a.get('numero', '')} {a['rep']}":
        numero = a.get("numero", "")  # « 12 bis » inchangé : le « bis » reste à part
    lat = a["lat"] if lat is None else lat
    lon = a["lon"] if lon is None else lon
    if _distance_m(orig["lat"], orig["lon"], lat, lon) > 3000:
        raise HTTPException(status_code=422, detail="Le nouveau point est à plus de 3 km de l'adresse d'origine : vérifiez la position")
    before = a["label"]
    moved = _distance_m(a["lat"], a["lon"], lat, lon)
    if numero == orig.get("numero", "") and nom_voie == orig.get("nom_voie", "") and _distance_m(orig["lat"], orig["lon"], lat, lon) < 0.5:
        db.delete_correction(slug, address_id)
    else:
        db.set_correction(slug, address_id, numero, nom_voie, lat, lon, _actor(request)[0])
    after = next(x for x in _addresses(slug, data) if x["id"] == address_id)
    details = f"{before} → {after['label']}" + (f" · point déplacé de {round(moved)} m" if moved >= 1 else "")
    if not after.get("corrigee"):
        details += " (retour à l'adresse d'origine)"
    _log(request, "adresse.corrigee", f"{data['commune']['nom']} · {after['label']}", details)
    return after


@app.put("/api/admin/communes/{slug}/addresses/{address_id}/correction", dependencies=[Depends(auth.require("secteurs", "suivi"))])
def admin_correct_address(slug: str, address_id: str, payload: AdresseCorrectionIn, request: Request):
    return _correct_address(request, slug, address_id, payload.numero, payload.nom_voie, payload.lat, payload.lon)


@app.delete("/api/admin/communes/{slug}/addresses/{address_id}/correction", dependencies=[Depends(auth.require("secteurs", "suivi"))])
def admin_uncorrect_address(slug: str, address_id: str, request: Request):
    data = _load_commune(slug)
    a = next((x for x in _addresses(slug, data) if x["id"] == address_id), None)
    if not a:
        raise HTTPException(status_code=404, detail="Adresse inconnue")
    if a.get("corrigee"):
        o = a["origine"]
        return _correct_address(request, slug, address_id, o["numero"], o["nom_voie"], o["lat"], o["lon"])
    return a


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
    _log(request, "avancement", _sector_label(sector_id), STATUT_FR.get(payload.statut, payload.statut))
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
    db.touch_personnes([pid])
    _log(request, "equipe.renfort", _sector_label(sector_id),
         f"{db.get_personne(pid)['nom']} ajouté(e) en équipier{' (nouvelle personne)' if payload.personne else ''}")
    return _team_view(sector_id)


@app.delete("/api/equipe/secteurs/{sector_id}/equipiers/{personne_id}")
def team_remove_member(sector_id: int, personne_id: int, request: Request):
    """Le responsable retire un équipier (absent) ; les responsables restent gérés par l'admin."""
    _require_lead(request, sector_id, TEAM_LEAD_ONLY)
    if not db.remove_member(sector_id, personne_id, "equipier"):
        raise HTTPException(status_code=404, detail="Cet équipier n'est pas dans l'équipe")
    gone = db.get_personne(personne_id)
    _log(request, "equipe.retrait", _sector_label(sector_id), f"{gone['nom'] if gone else personne_id} retiré(e) de l'équipe")
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
    _require_lead(request, sector_id)
    _check_open(_annee())
    person = auth.team_member(request)
    before = _caisse(sector_id)["reste"]  # ce qui restait à remettre avant cette remise
    db.add_remise({
        "annee": _annee(), "sector_id": sector_id,
        "especes_cents": round(payload.especes * 100), "cheques_cents": round(payload.cheques * 100),
        "nb_cheques": payload.nb_cheques,
        "attendu_especes_cents": round(before["especes"] * 100), "attendu_cheques_cents": round(before["cheques"] * 100),
        "remis_par": person["nom"] if person else _actor(request)[0],
        "recu_par": payload.recu_par, "note": payload.note,
    })
    _log(request, "remise.declaree", _sector_label(sector_id),
         f"{_euros(round(payload.especes * 100))} espèces + {_euros(round(payload.cheques * 100))} chèques ({payload.nb_cheques}) "
         f"remis à {payload.recu_par}{' · ' + payload.note if payload.note else ''}")
    return _caisse(sector_id)


@app.post("/api/admin/remises/{remise_id}/confirmer", dependencies=[Depends(auth.require("dons"))])
def admin_confirm_handover(remise_id: int, payload: ConfirmIn, request: Request):
    r = db.get_remise(remise_id)
    if not r or r["annule_le"]:
        raise HTTPException(status_code=404, detail="Remise inconnue")
    _check_open(r["annee"])
    _log(request, "remise.confirmee" if payload.confirme else "remise.annulee", _sector_label(r["sector_id"]),
         f"{_euros(r['especes_cents'] + r['cheques_cents'])} remis par {r['remis_par']} à {r['recu_par']}")
    return db.confirm_remise(remise_id, payload.confirme)


@app.delete("/api/admin/remises/{remise_id}", dependencies=[Depends(auth.require("dons"))])
def admin_delete_handover(remise_id: int, request: Request):
    r = db.get_remise(remise_id)
    if not r or r["annule_le"]:
        raise HTTPException(status_code=404, detail="Remise inconnue")
    _check_open(r["annee"])
    db.cancel_remise(remise_id, _actor(request)[0])
    _log(request, "remise.suppression", _sector_label(r["sector_id"]),
         f"{_euros(r['especes_cents'])} espèces + {_euros(r['cheques_cents'])} chèques, remis par {r['remis_par']} à {r['recu_par']}")
    return {"ok": True}


# ---- Sauvegardes --------------------------------------------------------------------

BACKUP_NAME = re.compile(r"^calendriers-[0-9_-]+(-[a-z]+)?\.db$")


@app.get("/api/admin/sauvegardes", dependencies=[Depends(auth.require("reglages"))])
def admin_list_backups():
    return {"sauvegardes": db.list_backups(), "dossier": db.backup_dir(), "garde": db.BACKUP_KEEP}


@app.post("/api/admin/sauvegardes", dependencies=[Depends(auth.require("reglages"))])
def admin_backup_now(request: Request):
    name = db.make_backup("manuelle")
    _log(request, "sauvegarde", name)
    return {"nom": name, "sauvegardes": db.list_backups()}


@app.get("/api/admin/sauvegardes/{name}", dependencies=[Depends(auth.require("reglages"))])
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
            _don_marks_done(don, don["personne_nom"] or "SumUp")
        db.log("SumUp", "système", "don.statut", f"{_sector_label(don['sector_id'])} · {_addr_label(don['commune_slug'], don['address_id'])}",
               f"{_euros(don['montant_cents'])} carte : {'payé' if statut == 'ok' else 'refusé'}"
               f"{' · n° ' + payload.tx_code if payload.tx_code else ''} (saisi par {don['personne_nom']})")
    return {"statut": don["statut"], "montant": don["montant_cents"] / 100, "mode": don["mode"],
            "slug": don["commune_slug"], "sector_id": don["sector_id"], "address_id": don["address_id"]}


def _euros(cents: int) -> str:
    return f"{cents / 100:.2f}".replace(".", ",") + " €"


STATUT_FR = {"a_faire": "à faire", "en_cours": "en cours", "termine": "terminé"}
MODE_FR = {"especes": "espèces", "cheque": "chèque", "cb": "carte"}
# dons hors tournée : sans adresse ni secteur (secteur 0), reçus directement par le trésorier
ANNEXE = 0
ANNEXE_LABEL = "Dons hors tournée"
ORIGINES = {"boite": "Boîte aux lettres de la caserne", "decale": "Reçu après la tournée (adresse inconnue)",
            "caserne": "Remis à la caserne", "autre": "Autre"}
STATUS_FR = {"fait": "fait", "absent": "absent", "refus": "refus", None: "à faire"}


# ---- API admin -----------------------------------------------------------------

def _set_session(response: Response, account: dict | None) -> None:
    response.set_cookie(
        auth.COOKIE_NAME, auth.make_token(account), max_age=auth.SESSION_SECONDS,
        httponly=True, samesite="strict", secure=auth.COOKIE_SECURE, path="/",
    )


@app.post("/api/admin/login")
def login(payload: LoginIn, request: Request, response: Response):
    ip = auth.client_ip(request)
    if auth.too_many_attempts(ip):
        raise HTTPException(status_code=429, detail="Trop d'essais : réessayez dans quelques minutes")
    ident = payload.identifiant.strip()
    if not ident:
        if plateforme.current.get() is not None:
            raise HTTPException(status_code=422, detail="Indiquez votre identifiant")
        if not auth.admin_password():
            raise HTTPException(status_code=503, detail="ADMIN_PASSWORD n'est pas configuré sur le serveur")
        if not auth.check_password(payload.password):
            auth.record_failure(ip)
            db.log(auth.PRINCIPAL_NAME, "console", "connexion.echec", "compte principal", f"adresse {ip}")
            time.sleep(1)  # ralentit les essais en série
            raise HTTPException(status_code=401, detail="Mot de passe incorrect")
        _set_session(response, None)
        db.log(auth.PRINCIPAL_NAME, "console", "connexion")
        return {"ok": True}
    found = db.compte_login(ident)
    if not found or not auth.verify_password(payload.password, found[1]):
        auth.record_failure(ip)
        db.log(ident, "console", "connexion.echec", ident, f"adresse {ip}")
        time.sleep(1)
        raise HTTPException(status_code=401, detail="Identifiant ou mot de passe incorrect")
    account = found[0]
    if not account["actif"]:
        raise HTTPException(status_code=403, detail="Ce compte est désactivé")
    _set_session(response, account)
    db.touch_compte(account["id"])
    db.log(account["nom"], "console", "connexion", account["role"])
    return {"ok": True}


@app.post("/api/admin/logout")
def logout(response: Response):
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/admin/me", dependencies=[Depends(auth.require_admin)])
def me(request: Request):
    u = auth.console_user(request)
    return {"admin": True, "id": u["id"], "nom": u["nom"], "identifiant": u.get("identifiant", ""), "role": u["role"],
            "principal": u["principal"], "permissions": u["permissions"]}


@app.post("/api/admin/mot-de-passe", dependencies=[Depends(auth.require_admin)])
def change_own_password(payload: MotDePasseIn, request: Request, response: Response):
    u = auth.console_user(request)
    if u["principal"]:
        raise HTTPException(status_code=409, detail="Le mot de passe principal se change dans le fichier .env (ADMIN_PASSWORD)")
    found = db.compte_login(u["identifiant"])
    if not found or not auth.verify_password(payload.actuel, found[1]):
        raise HTTPException(status_code=401, detail="Mot de passe actuel incorrect")
    account = db.update_compte(u["id"], mdp_hash=auth.hash_password(payload.nouveau))
    _set_session(response, account)  # les autres sessions sont coupées, celle-ci continue
    db.log(u["nom"], "console", "compte.mot_de_passe", u["nom"], "a changé son mot de passe")
    return {"ok": True}


def _actor(request: Request) -> tuple[str, str]:
    """Qui fait l'action (pour le journal) : compte de la console, membre d'équipe, ou système."""
    u = auth.console_user(request)
    if u:
        return u["nom"], "console"
    p = auth.team_member(request)
    if p:
        return p["nom"], "terrain"
    return "Système", "système"


def _log(request: Request, action: str, objet: str = "", details: str = "") -> None:
    qui, source = _actor(request)
    db.log(qui, source, action, objet, details)


def _addr_label(slug: str, address_id: str) -> str:
    try:
        data = _load_commune(slug)
    except HTTPException:
        return address_id
    for a in _addresses(slug, data):
        if a["id"] == address_id:
            return _full_label(a)
    return address_id


def _full_label(a: dict) -> str:
    """Adresse avec le nom de l'entreprise : « 12 Rue X (Garage Martin) »."""
    return f"{a['label']} ({a['entreprise']})" if a.get("entreprise") else a["label"]


def _sector_label(sector_id: int | None) -> str:
    return _sector_labels().get(sector_id, f"secteur {sector_id}") if sector_id else ""


PUBLIC_SETTINGS = ("suivi_adresses", "annee", "equipes_public", "telephones_public", "dons_actifs", "sumup_actif", "avancement")
SETTING_PERMS = {  # qui peut changer quoi
    "equipes_public": ("reglages", "equipes"), "telephones_public": ("reglages", "equipes"),
    "whatsapp_bot_url": ("reglages", "equipes"), "whatsapp_bot_key": ("reglages", "equipes"),
    "whatsapp_message": ("reglages", "equipes"),
    "avancement": ("reglages", "suivi"),
    "asso_nom": ("reglages", "dons"), "asso_adresse": ("reglages", "dons"), "asso_siret": ("reglages", "dons"),
}


@app.get("/api/admin/settings", dependencies=[Depends(auth.require_admin)])
def admin_get_settings(request: Request):
    full = {"suivi_adresses": _suivi_enabled(), "annee": _annee(),
            "equipes_public": _flag("equipes_public", True), "telephones_public": _flag("telephones_public", False),
            "dons_actifs": _flag("dons_actifs", False), "sumup_actif": _flag("sumup_actif", False),
            "sumup_affiliate_key": db.get_setting("sumup_affiliate_key", "") or "",
            "sumup_app_id": db.get_setting("sumup_app_id", "") or "",
            "whatsapp_bot_url": db.get_setting("whatsapp_bot_url", "") or "",
            # la clé du bot n'est jamais renvoyée : on dit seulement si elle est réglée
            "whatsapp_bot_key_set": bool(db.get_setting("whatsapp_bot_key", "")),
            "whatsapp_message": db.get_setting("whatsapp_message", "") or whatsapp.DEFAULT_MESSAGE,
            "whatsapp_message_defaut": whatsapp.DEFAULT_MESSAGE,
            "asso_nom": db.get_setting("asso_nom", "") or "", "asso_adresse": db.get_setting("asso_adresse", "") or "",
            "asso_siret": db.get_setting("asso_siret", "") or "",
            **{k: db.get_setting(k, "") or "" for k in ("editeur", "contact_email", "contact_tel", "hebergeur")},
            **{k: float(db.get_setting(k, "") or d) for k, d in RETENTION_DEFAULTS.items()},
            "recus_actifs": _flag("recus_actifs", True),
            "caserne_nom": _branding()["nom"], "caserne_couleur": _branding()["couleur"],
            "caserne_logo": _branding()["logo"], "caserne_logo_perso": _branding()["logo_perso"],
            "avancement": _avancement(),
            "purge_derniere": json.loads(db.get_setting("purge_derniere", "") or "null"),
            # copie hors du serveur : les mots de passe ne sont jamais renvoyés
            "offsite_mode": db.get_setting("offsite_mode", "") or "", "offsite_url": db.get_setting("offsite_url", "") or "",
            "offsite_user": db.get_setting("offsite_user", "") or "", "offsite_dossier": db.get_setting("offsite_dossier", "") or "",
            "offsite_garder": int(db.get_setting("offsite_garder", "") or 30),
            "offsite_password_set": bool(db.get_setting("offsite_password", "")),
            "offsite_passphrase_set": bool(db.get_setting("offsite_passphrase", "")),
            "offsite_dernier": json.loads(db.get_setting("offsite_dernier", "") or "null")}
    if plateforme.current.get() is not None:  # bot WhatsApp géré par l'admin central : rien à régler ici
        for k in ("whatsapp_bot_url", "whatsapp_bot_key_set"):
            full.pop(k, None)
        full["whatsapp_plateforme"] = True
    if auth.has_perm(request, "reglages"):
        return full
    out = {k: full[k] for k in PUBLIC_SETTINGS}
    if auth.has_perm(request, "dons"):
        out.update({k: v for k, v in full.items() if k.startswith("asso_")})
    if auth.has_perm(request, "equipes"):
        out.update({k: v for k, v in full.items() if k.startswith("whatsapp_")})
    return out


@app.put("/api/admin/settings", dependencies=[Depends(auth.require_admin)])
def admin_save_settings(payload: SettingsIn, request: Request):
    sent = payload.model_dump(exclude_none=True)
    if plateforme.current.get() is not None and {"whatsapp_bot_url", "whatsapp_bot_key"} & set(sent):
        raise HTTPException(status_code=403, detail="Le bot WhatsApp est géré par l'administrateur de la plateforme")
    for key in sent:
        if not auth.has_perm(request, *SETTING_PERMS.get(key, ("reglages",))):
            raise HTTPException(status_code=403, detail="Votre rôle ne permet pas de changer ce réglage")
    before = admin_get_settings(request)
    if payload.suivi_adresses is not None:
        db.set_setting("suivi_adresses", "1" if payload.suivi_adresses else "0")
    if payload.annee is not None:
        db.set_setting("annee", str(payload.annee))
    for key in ("equipes_public", "telephones_public", "dons_actifs", "sumup_actif", "recus_actifs"):
        value = getattr(payload, key)
        if value is not None:
            db.set_setting(key, "1" if value else "0")
    for key in ("sumup_affiliate_key", "sumup_app_id", "whatsapp_bot_url", "whatsapp_bot_key", "asso_nom", "asso_adresse", "asso_siret",
                "editeur", "contact_email", "contact_tel", "hebergeur", "offsite_mode", "offsite_url", "offsite_user",
                "offsite_password", "offsite_dossier", "offsite_passphrase", "avancement", "caserne_couleur"):
        value = getattr(payload, key)
        if value is not None:
            db.set_setting(key, value)
    for key in (*RETENTION_DEFAULTS, "offsite_garder"):
        value = getattr(payload, key)
        if value is not None:
            db.set_setting(key, str(value))
    if payload.caserne_nom is not None:
        db.set_setting("caserne_nom", " ".join(payload.caserne_nom.split()))
    if payload.whatsapp_message is not None:
        msg = payload.whatsapp_message.strip()
        db.set_setting("whatsapp_message", "" if msg == whatsapp.DEFAULT_MESSAGE.strip() else msg)
    after = admin_get_settings(request)
    shown = lambda v: "oui" if v is True else "non" if v is False else str(v)  # noqa: E731
    changes = []
    for key in sent:
        if key in ("whatsapp_bot_key", "sumup_affiliate_key", "whatsapp_message", "offsite_password", "offsite_passphrase"):
            changes.append(f"{key} modifié")
        elif before.get(key) != after.get(key):
            changes.append(f"{key} : {shown(before.get(key))} → {shown(after.get(key))}")
    if changes:
        _log(request, "reglages", "réglages", " · ".join(changes))
    return after


RETENTION_DEFAULTS = {"retention_tel_ans": 3.0, "retention_notes_ans": 3.0, "retention_connexions_mois": 12.0,
                      "retention_journal_ans": 6.0}


def _purge(qui: str) -> dict:
    vals = {k: float(db.get_setting(k, "") or d) for k, d in RETENTION_DEFAULTS.items()}
    out = db.purge_personal_data(vals["retention_tel_ans"], vals["retention_notes_ans"],
                                 vals["retention_connexions_mois"], vals["retention_journal_ans"])
    report = {"at": db._now(), "par": qui, **out}
    db.set_setting("purge_derniere", json.dumps(report))
    if any(out.values()):
        db.log(qui, "système" if qui.startswith("Nettoyage") else "console", "rgpd.nettoyage", "données personnelles",
               f"{out['telephones']} téléphone(s), {out['notes']} note(s), {out['connexions']} connexion(s), "
               f"{out['journal']} ancienne(s) ligne(s) du journal effacé(s)")
    return report


@app.post("/api/admin/rgpd/nettoyer", dependencies=[Depends(auth.require("reglages"))])
def admin_purge_now(request: Request):
    return _purge(_actor(request)[0])


def _offsite_cfg() -> dict | None:
    mode = db.get_setting("offsite_mode", "") or ""
    if not mode:
        return None
    return {"mode": mode, "url": db.get_setting("offsite_url", "") or "", "user": db.get_setting("offsite_user", "") or "",
            "password": db.get_setting("offsite_password", "") or "", "dossier": db.get_setting("offsite_dossier", "") or "",
            "garder": int(db.get_setting("offsite_garder", "") or 30), "passphrase": db.get_setting("offsite_passphrase", "") or ""}


def _offsite_copy(name: str) -> dict | None:
    """Chiffre la sauvegarde `name` et l'envoie hors du serveur ; garde le compte rendu."""
    cfg = _offsite_cfg()
    if not cfg:
        return None
    status = {"at": db._now(), "fichier": f"{name}.chiffre"}
    try:
        if not cfg["passphrase"]:
            raise offsite.OffsiteError("phrase secrète de chiffrement non réglée")
        with open(os.path.join(db.backup_dir(), name), "rb") as fh:
            blob = offsite.encrypt(fh.read(), cfg["passphrase"])
        offsite.push(cfg, f"{name}.chiffre", blob)
        status.update(ok=True, message=f"copie envoyée ({len(blob) // 1024} Ko, chiffrée)")
    except (offsite.OffsiteError, OSError) as err:
        status.update(ok=False, message=str(err))
        db.log("Sauvegarde externe", "système", "sauvegarde.externe.echec", status["fichier"], str(err))
    db.set_setting("offsite_dernier", json.dumps(status))
    return status


@app.post("/api/admin/sauvegarde-externe/test", dependencies=[Depends(auth.require("reglages"))])
def admin_offsite_now(request: Request):
    """Fait une sauvegarde maintenant et l'envoie hors du serveur (pour vérifier le réglage)."""
    if not _offsite_cfg():
        raise HTTPException(status_code=409, detail="Copie hors du serveur non réglée")
    name = db.make_backup("manuelle")
    status = _offsite_copy(name)
    _log(request, "sauvegarde.externe", status["fichier"], status["message"])
    return status


# ---- Comptes et rôles de la console ------------------------------------------------

@app.get("/api/admin/comptes", dependencies=[Depends(auth.require("comptes"))])
def admin_list_accounts():
    return {"comptes": db.list_comptes(), "roles": db.list_roles(), "permissions": db.PERMISSIONS}


def _check_role(role_id: int) -> dict:
    role = db.get_role(role_id)
    if not role:
        raise HTTPException(status_code=404, detail="Rôle inconnu")
    return role


@app.post("/api/admin/comptes", dependencies=[Depends(auth.require("comptes"))])
def admin_add_account(payload: CompteIn, request: Request):
    role = _check_role(payload.role_id)
    if db.compte_login(payload.identifiant):
        raise HTTPException(status_code=409, detail="Cet identifiant existe déjà")
    acc = db.add_compte(payload.identifiant.strip(), payload.nom, auth.hash_password(payload.password), payload.role_id)
    _log(request, "compte.ajout", acc["nom"], f"identifiant {acc['identifiant']} · rôle {role['nom']}")
    return acc


@app.put("/api/admin/comptes/{compte_id}", dependencies=[Depends(auth.require("comptes"))])
def admin_update_account(compte_id: int, payload: CompteUpdateIn, request: Request):
    acc = db.get_compte(compte_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Compte inconnu")
    me_ = auth.console_user(request)
    if me_["id"] == compte_id and (payload.actif is False or payload.role_id not in (None, acc["role_id"])):
        raise HTTPException(status_code=409, detail="Vous ne pouvez pas désactiver votre propre compte ni changer votre rôle")
    if payload.role_id is not None:
        _check_role(payload.role_id)
    updated = db.update_compte(compte_id, nom=" ".join(payload.nom.split()) if payload.nom else None, role_id=payload.role_id,
                               actif=payload.actif,
                               mdp_hash=auth.hash_password(payload.password) if payload.password else None)
    changes = []
    if payload.nom and updated["nom"] != acc["nom"]:
        changes.append(f"nom : {acc['nom']} → {updated['nom']}")
    if payload.role_id is not None and updated["role"] != acc["role"]:
        changes.append(f"rôle : {acc['role']} → {updated['role']}")
    if payload.actif is not None and payload.actif != acc["actif"]:
        changes.append("réactivé" if payload.actif else "désactivé")
    if payload.password:
        changes.append("nouveau mot de passe")
    if changes:
        _log(request, "compte.modif", updated["nom"], " · ".join(changes))
    return updated


@app.delete("/api/admin/comptes/{compte_id}", dependencies=[Depends(auth.require("comptes"))])
def admin_delete_account(compte_id: int, request: Request):
    acc = db.get_compte(compte_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Compte inconnu")
    if auth.console_user(request)["id"] == compte_id:
        raise HTTPException(status_code=409, detail="Vous ne pouvez pas supprimer votre propre compte")
    db.delete_compte(compte_id)
    _log(request, "compte.suppression", acc["nom"], f"identifiant {acc['identifiant']}")
    return {"ok": True}


@app.post("/api/admin/roles", dependencies=[Depends(auth.require("comptes"))])
def admin_add_role(payload: RoleIn, request: Request):
    if any(r["nom"].lower() == payload.nom.lower() for r in db.list_roles()):
        raise HTTPException(status_code=409, detail="Ce rôle existe déjà")
    role = db.save_role(None, payload.nom, payload.permissions)
    _log(request, "role.ajout", role["nom"], ", ".join(role["permissions"]) or "aucun droit")
    return role


@app.put("/api/admin/roles/{role_id}", dependencies=[Depends(auth.require("comptes"))])
def admin_update_role(role_id: int, payload: RoleIn, request: Request):
    role = _check_role(role_id)
    if role["fixe"]:
        raise HTTPException(status_code=409, detail="Le rôle Administrateur garde tous les droits")
    if any(r["nom"].lower() == payload.nom.lower() and r["id"] != role_id for r in db.list_roles()):
        raise HTTPException(status_code=409, detail="Ce rôle existe déjà")
    updated = db.save_role(role_id, payload.nom, payload.permissions)
    _log(request, "role.modif", updated["nom"], f"droits : {', '.join(updated['permissions']) or 'aucun'}")
    return updated


@app.delete("/api/admin/roles/{role_id}", dependencies=[Depends(auth.require("comptes"))])
def admin_delete_role(role_id: int, request: Request):
    role = _check_role(role_id)
    if role["fixe"]:
        raise HTTPException(status_code=409, detail="Le rôle Administrateur ne peut pas être supprimé")
    if db.role_in_use(role_id):
        raise HTTPException(status_code=409, detail="Des comptes ont encore ce rôle : changez-leur de rôle d'abord")
    db.delete_role(role_id)
    _log(request, "role.suppression", role["nom"])
    return {"ok": True}


# ---- Journal des modifications ------------------------------------------------------

@app.get("/api/admin/journal", dependencies=[Depends(auth.require("journal", "comptes"))])
def admin_journal(before: int | None = None, q: str = "", action: str = "", qui: str = "", limit: int = 200):
    limit = max(1, min(limit, 5000))
    return {"entrees": db.list_journal(limit, before, q.strip()[:80], action.strip()[:40], qui.strip()[:80]),
            "personnes": db.journal_people()}


# ---- Envoi des codes d'accès par le bot WhatsApp ---------------------------------

_send_lock = threading.Lock()
_last_send = 0.0
MIN_GAP = 1.5  # secondes entre deux messages, même si plusieurs onglets envoient (anti-spam WhatsApp)


BOT_OFF = "L'envoi par le bot WhatsApp n'est pas activé pour votre caserne : demandez-le à l'administrateur de la plateforme."


def _bot_conf() -> tuple[str, str]:
    """Bot WhatsApp : réglé dans l'admin de l'installation simple ; sur la plateforme, géré par l'admin central."""
    cas = plateforme.current.get()
    if cas is not None:
        conf = plateforme.bot_for(cas)
        return conf if conf else ("", "")
    return db.get_setting("whatsapp_bot_url", "") or "", db.get_setting("whatsapp_bot_key", "") or ""


def _bot() -> tuple[str, str]:
    url, key = _bot_conf()
    if not url:
        raise HTTPException(status_code=409, detail=BOT_OFF if plateforme.current.get() is not None else "Adresse du bot WhatsApp non réglée")
    return url, key


def _sector_labels() -> dict[int, str]:
    out = {ANNEXE: ANNEXE_LABEL}
    for slug in _all_slugs():
        nom = _load_commune(slug)["commune"]["nom"]
        for i, s in enumerate(db.list_sectors(slug)):
            if s["id"] not in out:  # la tournée des entreprises (toutes communes) : code « E »
                out[s["id"]] = f"E {s['nom']}" if s["kind"] == "entreprises" else f"{(nom or '?').strip()[:1].upper()}{i + 1} {s['nom']}"
    return out


def _access_message(p: dict, origin: str, template: str | None) -> str:
    labels = _sector_labels()
    where = [f"{labels[sid]}{' (responsable)' if role == 'responsable' else ''}"
             for sid, role in db.memberships(p["id"]).items() if sid in labels]

    code = p["code"] or ""
    annee = _annee()
    return whatsapp.render(template or db.get_setting("whatsapp_message", "") or whatsapp.DEFAULT_MESSAGE, {
        "prenom": p["nom"].split(" ")[0], "nom": p["nom"], "code": f"{code[:4]}-{code[4:]}",
        "lien": f"{origin}/equipe#acces={code}", "annee": str(annee),
        "tournee": f"tournée des calendriers {annee}", "caserne": _branding()["nom"],
        "secteurs": ", avec accès à toutes les tournées (superviseur)" if p.get("superviseur")
        else f", secteur {', '.join(where)}" if where else "",
    })


def _person_or_404(personne_id: int) -> dict:
    p = db.get_personne(personne_id)
    if not p:
        raise HTTPException(status_code=404, detail="Personne inconnue")
    return p


@app.get("/api/admin/whatsapp/etat", dependencies=[Depends(auth.require("equipes", "reglages"))])
def admin_bot_state():
    url, key = _bot_conf()
    managed = plateforme.current.get() is not None
    if not url:
        return {"configure": False, "pret": False, "plateforme": managed,
                "erreur": "Bot non activé pour votre caserne (géré par la plateforme)" if managed else "Adresse du bot non réglée"}
    try:
        h = whatsapp.health(url, key)
    except whatsapp.BotError as err:
        return {"configure": True, "pret": False, "erreur": str(err)}
    ready = bool(h.get("ready", h.get("ok")))
    return {"configure": True, "pret": ready, "plateforme": managed,
            "erreur": "" if ready else "Le bot répond mais WhatsApp n'est pas connecté (QR à rescanner ?)"}


@app.post("/api/admin/whatsapp/apercu", dependencies=[Depends(auth.require("equipes"))])
def admin_bot_preview(payload: EnvoiAccesIn):
    p = _person_or_404(payload.personne_id)
    return {"message": _access_message(p, payload.origin, payload.modele), "to": whatsapp.whatsapp_id(p["telephone"])}


@app.post("/api/admin/whatsapp/envoyer", dependencies=[Depends(auth.require("equipes"))])
def admin_bot_send_access(payload: EnvoiAccesIn, request: Request):
    """Envoie à une personne son code et son lien d'accès, directement par le bot WhatsApp.
    L'écran admin appelle cette route personne par personne (avec la progression)."""
    global _last_send
    p = _person_or_404(payload.personne_id)
    to = whatsapp.whatsapp_id(p["telephone"])
    if not to:
        raise HTTPException(status_code=422, detail="Pas de numéro de téléphone valable")
    url, key = _bot()
    message = _access_message(p, payload.origin, None)
    with _send_lock:
        wait = MIN_GAP - (time.monotonic() - _last_send)
        if wait > 0:
            time.sleep(wait)
        try:
            whatsapp.send(url, key, to, message)
        except whatsapp.BotError as err:
            raise HTTPException(status_code=err.status, detail=str(err)) from err
        finally:
            _last_send = time.monotonic()
    _log(request, "acces.envoi", p["nom"], f"code d'accès envoyé par WhatsApp au {p['telephone']}")
    return {"ok": True, "acces_envoye_le": db.mark_access_sent(p["id"])}


# ---- Équipes ---------------------------------------------------------------------

@app.get("/api/admin/equipes", dependencies=[Depends(auth.require("equipes"))])
def admin_get_equipes():
    sector_ids = db.existing_sector_ids()
    teams = {sid: t for sid, t in db.get_teams().items() if sid in sector_ids}
    return {"personnes": db.list_personnes(), "equipes": teams}


@app.post("/api/admin/personnes", dependencies=[Depends(auth.require("equipes"))])
def admin_add_personnes(payload: PersonnesIn, request: Request):
    if len(db.list_personnes()) + len(payload.personnes) > 500:
        raise HTTPException(status_code=422, detail="Trop de personnes (500 au maximum)")
    added = db.add_personnes([p.model_dump() for p in payload.personnes])
    _log(request, "personne.ajout", ", ".join(p["nom"] for p in added)[:200], f"{len(added)} personne(s)")
    return {"personnes": added}


@app.put("/api/admin/personnes/{personne_id}", dependencies=[Depends(auth.require("equipes"))])
def admin_update_personne(personne_id: int, payload: PersonneIn, request: Request):
    old = db.get_personne(personne_id)
    person = db.update_personne(personne_id, payload.nom, payload.telephone)
    if person is None:
        raise HTTPException(status_code=404, detail="Personne inconnue")
    changes = [f"{k} : {old[k] or '—'} → {person[k] or '—'}" for k in ("nom", "telephone") if old[k] != person[k]]
    if changes:
        _log(request, "personne.modif", person["nom"], " · ".join(changes))
    return person


@app.delete("/api/admin/personnes/{personne_id}", dependencies=[Depends(auth.require("equipes"))])
def admin_delete_personne(personne_id: int, request: Request):
    old = db.get_personne(personne_id)
    if not db.delete_personne(personne_id):
        raise HTTPException(status_code=404, detail="Personne inconnue")
    _log(request, "personne.suppression", old["nom"])
    return {"ok": True}


@app.put("/api/admin/personnes/{personne_id}/superviseur", dependencies=[Depends(auth.require("equipes"))])
def admin_set_supervisor(personne_id: int, payload: SuperviseurIn, request: Request):
    old = db.get_personne(personne_id)
    if not old:
        raise HTTPException(status_code=404, detail="Personne inconnue")
    person = db.set_superviseur(personne_id, payload.superviseur)
    if old["superviseur"] != person["superviseur"]:
        _log(request, "personne.superviseur", person["nom"],
             "devient superviseur : accès à toutes les tournées" if person["superviseur"] else "n'est plus superviseur")
    return person


@app.post("/api/admin/personnes/{personne_id}/code", dependencies=[Depends(auth.require("equipes"))])
def admin_regenerate_code(personne_id: int, request: Request):
    person = db.regenerate_code(personne_id)
    if person is None:
        raise HTTPException(status_code=404, detail="Personne inconnue")
    _log(request, "personne.code", person["nom"], "nouveau code d'accès (l'ancien ne marche plus)")
    return person


@app.get("/api/admin/bilan", dependencies=[Depends(auth.require("suivi", "dons"))])
def admin_bilan():
    annee = _annee()
    dons = db.list_dons(annee)
    rows = []
    statuses_of = {slug: db.get_statuses(slug) for slug in _all_slugs()}
    for t in _tours():
        s = t["sector"]
        ids = [a["id"] for _, a in t["addrs"]]
        counts = {"fait": 0, "absent": 0, "refus": 0, "a_faire": 0}
        for sl, a in t["addrs"]:
            counts[(statuses_of[sl].get(a["id"]) or {}).get("status") or "a_faire"] += 1
        rows.append({"sector_id": s["id"], "slug": t["slug"], "commune": t["commune"], "nom": s["nom"],
                     "couleur": s["couleur"], "adresses": len(ids), "counts": counts, "kind": s["kind"],
                     "polygon": t["polygon"],
                     "totaux": _totaux([d for d in dons if d["sector_id"] == s["id"]]),
                     "caisse": _caisse(s["id"])})
    return {"annee": annee, "secteurs": rows, "totaux": _totaux(dons),
            "annexes": _totaux([d for d in dons if d["sector_id"] == ANNEXE]),
            "attente": [_don_view(d, True, None) | {"sector_id": d["sector_id"], "slug": d["commune_slug"]}
                        for d in dons if d["statut"] == "attente"]}


@app.get("/api/admin/bilan-annee", dependencies=[Depends(auth.require("dons"))])
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
    tours = _tours()
    per = {t["sector"]["id"]: {y: blank() for y in years} for t in tours}
    for slug in _all_slugs():
        _, _, by_sector = _sector_map(slug)
        where = {a["id"]: sid for sid, addrs in by_sector.items() for a in addrs}
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
    annexes = {y: [d for d in db.list_dons(y) if d["sector_id"] == ANNEXE and d["statut"] == "ok"] for y in years}
    for y in years:  # dons hors tournée : sans adresse, comptés dans le total seulement
        totals[y]["dons"].extend(annexes[y])
    for t in tours:  # chaque tournée une fois (la tournée des entreprises couvre plusieurs communes)
        s = t["sector"]
        team = teams.get(s["id"]) or {"membres": []}
        rows.append({"sector_id": s["id"], "commune": t["commune"], "slug": t["slug"], "nom": s["nom"],
                     "couleur": s["couleur"], "kind": s["kind"],
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
        "annexes": {str(y): _totaux(v) for y, v in annexes.items()},
        "totaux": {str(y): {**{k: t[k] for k in ("adresses", "fait", "absent", "refus")}, "dons": _totaux(t["dons"])}
                   for y, t in totals.items()},
        "remises": {"nb": len(remises), "total": sum(r["especes_cents"] + r["cheques_cents"] for r in remises) / 100,
                    "confirmees": sum(1 for r in remises if r["confirme_le"])},
    }


# ---- Dossier comptable et fiscal ----------------------------------------------------

try:
    PARIS = ZoneInfo("Europe/Paris")
except Exception:  # noqa: BLE001 (base des fuseaux absente : heure d'hiver par défaut)
    PARIS = dt.timezone(dt.timedelta(hours=1))

STATUT_DON_FR = {"ok": "Encaissé", "attente": "En attente (SumUp)", "echec": "Paiement refusé"}


def _local(iso: str) -> dt.datetime:
    return dt.datetime.fromisoformat(iso).astimezone(PARIS)


def _registre(annee: int) -> list[dict]:
    """Tous les dons de l'année, annulés compris, dans l'ordre des numéros."""
    labels = _sector_labels()
    addr: dict[str, str] = {}
    communes: dict[str, str] = {}
    unit_labels = {slug: db.get_unit_labels(slug) for slug in _all_slugs()}
    for slug in _all_slugs():
        data = _load_commune(slug)
        communes[slug] = data["commune"]["nom"]
        for a in _addresses(slug, data):
            addr[f"{slug}/{a['id']}"] = _full_label(a)
    out = []
    for d in sorted(db.list_dons(annee, avec_annules=True), key=lambda x: x["numero"] or 0):
        out.append({
            "numero": d["numero"], "id": d["id"], "created_at": d["created_at"], "sector_id": d["sector_id"],
            "secteur": labels.get(d["sector_id"], f"secteur {d['sector_id']} (supprimé)"),
            "commune": communes.get(d["commune_slug"], d["commune_slug"]),
            "adresse": (ORIGINES.get(d["origine"], "Hors tournée") if d["sector_id"] == ANNEXE else
                        addr.get(f"{d['commune_slug']}/{d['address_id']}", d["address_id"]))
            + (f" · logement {d['logement']}" if d.get("logement") else "")
            + (f" ({unit_labels.get(d['commune_slug'], {}).get(d['address_id'], {}).get(d['logement'])})"
               if d.get("logement") and unit_labels.get(d["commune_slug"], {}).get(d["address_id"], {}).get(d["logement"]) else ""),
            "mode": d["mode"], "montant": d["montant_cents"] / 100, "reference": d["tx_code"],
            "statut": "annule" if d["annule_le"] else d["statut"], "saisi_par": d["personne_nom"], "annexe": d["sector_id"] == ANNEXE,
            "annule_le": d["annule_le"], "annule_par": d["annule_par"], "motif": d["motif"], "note": d["note"],
        })
    return out


def _csv(rows: list[list]) -> bytes:
    """CSV pour Excel (point-virgule, BOM) ; pas de formule cachée dans une cellule."""
    def cell(v) -> str:
        v = "" if v is None else str(v)
        if v[:1] in ("=", "+", "-", "@") and not re.fullmatch(r"-?[0-9]+(,[0-9]+)?", v):
            v = "'" + v
        return '"' + v.replace('"', '""') + '"'
    return ("﻿" + "\r\n".join(";".join(cell(c) for c in r) for r in rows) + "\r\n").encode("utf-8")


def _money(v: float) -> str:
    return f"{v:.2f}".replace(".", ",")


def _registre_csv(annee: int) -> bytes:
    rows = [["N°", "Date", "Heure", "Secteur", "Commune", "Adresse", "Moyen", "Montant (€)", "Référence (n° chèque / transaction)",
             "Statut", "Saisi par", "Annulé le", "Annulé par", "Motif d'annulation", "Note"]]
    for r in _registre(annee):
        t = _local(r["created_at"])
        a = _local(r["annule_le"]).strftime("%d/%m/%Y %H:%M") if r["annule_le"] else ""
        rows.append([r["numero"], t.strftime("%d/%m/%Y"), t.strftime("%H:%M:%S"), r["secteur"], r["commune"], r["adresse"],
                     MODE_FR[r["mode"]], _money(r["montant"]), r["reference"],
                     "Annulé" if r["statut"] == "annule" else STATUT_DON_FR[r["statut"]], r["saisi_par"], a,
                     r["annule_par"] or "", r["motif"] or "", r["note"]])
    return _csv(rows)


def _fiscal(annee: int) -> dict:
    reg = _registre(annee)
    ok = [r for r in reg if r["statut"] == "ok"]
    cents = lambda rows: round(sum(r["montant"] for r in rows) * 100)  # noqa: E731
    by_mode = {m: [r for r in ok if r["mode"] == m] for m in ("especes", "cheque", "cb")}
    total = cents(ok)
    synth = {
        "total": total / 100, "nb": len(ok), "moyen": (total / len(ok) / 100) if ok else 0,
        **{m: cents(rows) / 100 for m, rows in by_mode.items()}, **{f"nb_{m}": len(rows) for m, rows in by_mode.items()},
        "attente": {"nb": sum(1 for r in reg if r["statut"] == "attente"), "total": cents([r for r in reg if r["statut"] == "attente"]) / 100},
        "echecs": {"nb": sum(1 for r in reg if r["statut"] == "echec"), "total": cents([r for r in reg if r["statut"] == "echec"]) / 100},
        "annules": {"nb": sum(1 for r in reg if r["statut"] == "annule"), "total": cents([r for r in reg if r["statut"] == "annule"]) / 100},
    }
    # journal de caisse : un jour par ligne (heure de Paris)
    days: dict[str, dict] = {}
    for r in ok:
        k = _local(r["created_at"]).date().isoformat()
        day = days.setdefault(k, {"date": k, "nb": 0, "especes": 0, "cheque": 0, "cb": 0})
        day["nb"] += 1
        day[r["mode"]] += round(r["montant"] * 100)
    cumul = 0
    jours = []
    for k in sorted(days):
        d = days[k]
        t = d["especes"] + d["cheque"] + d["cb"]
        cumul += t
        jours.append({"date": k, "nb": d["nb"], "especes": d["especes"] / 100, "cheque": d["cheque"] / 100, "cb": d["cb"] / 100,
                      "total": t / 100, "cumul": cumul / 100})
    # par secteur et par collecteur
    remises_all = db.list_remises(annee, avec_annulees=True)
    remises = [r for r in remises_all if not r["annule_le"]]
    teams = db.get_teams()
    people = {p["id"]: p["nom"] for p in db.list_personnes()}
    labels = _sector_labels()
    maisons = {"adresses": 0, "fait": 0, "absent": 0, "refus": 0}
    secteurs = []
    statuses_of = {slug: db.get_statuses(slug, annee) for slug in _all_slugs()}
    for t in _tours():
        sct = t["sector"]
        ids = [a["id"] for _, a in t["addrs"]]
        c = {"fait": 0, "absent": 0, "refus": 0}
        for sl, a in t["addrs"]:
            st = (statuses_of[sl].get(a["id"]) or {}).get("status")
            if st in c:
                c[st] += 1
        maisons["adresses"] += len(ids)
        for k in c:
            maisons[k] += c[k]
        mine = [r for r in ok if r["sector_id"] == sct["id"]]
        rem = [r for r in remises if r["sector_id"] == sct["id"]]
        esp, chq = cents([r for r in mine if r["mode"] == "especes"]), cents([r for r in mine if r["mode"] == "cheque"])
        r_esp, r_chq = sum(r["especes_cents"] for r in rem), sum(r["cheques_cents"] for r in rem)
        secteurs.append({
            "sector_id": sct["id"], "secteur": labels.get(sct["id"], sct["nom"]),
            "responsables": [people[m["personne_id"]] for m in (teams.get(sct["id"]) or {"membres": []})["membres"]
                             if m["role"] == "responsable" and m["personne_id"] in people],
            "adresses": len(ids), **c, "nb": len(mine), "especes": esp / 100, "cheque": chq / 100,
            "cb": cents([r for r in mine if r["mode"] == "cb"]) / 100, "total": cents(mine) / 100,
            "remis_especes": r_esp / 100, "remis_cheques": r_chq / 100,
            "reste": (esp + chq - r_esp - r_chq) / 100,
        })
    # dons rattachés à un secteur supprimé depuis : comptés à part pour que les totaux tombent juste
    annexes = [r for r in ok if r["sector_id"] == ANNEXE]
    if annexes:  # reçus directement par le trésorier : rien à remettre
        a_esp, a_chq = cents([r for r in annexes if r["mode"] == "especes"]), cents([r for r in annexes if r["mode"] == "cheque"])
        secteurs.append({"sector_id": ANNEXE, "secteur": f"{ANNEXE_LABEL} (reçus par le trésorier)", "responsables": [], "adresses": 0,
                         "fait": 0, "absent": 0, "refus": 0, "nb": len(annexes), "especes": a_esp / 100, "cheque": a_chq / 100,
                         "cb": cents([r for r in annexes if r["mode"] == "cb"]) / 100, "total": cents(annexes) / 100,
                         "remis_especes": a_esp / 100, "remis_cheques": a_chq / 100, "reste": 0})
    known = {x["sector_id"] for x in secteurs}
    orphans = [r for r in ok if r["sector_id"] not in known]
    if orphans:
        secteurs.append({"sector_id": None, "secteur": "Secteurs supprimés depuis", "responsables": [], "adresses": 0,
                         "fait": 0, "absent": 0, "refus": 0, "nb": len(orphans),
                         **{m: cents([r for r in orphans if r["mode"] == m]) / 100 for m in ("especes", "cheque", "cb")},
                         "total": cents(orphans) / 100, "remis_especes": 0, "remis_cheques": 0,
                         "reste": cents([r for r in orphans if r["mode"] != "cb"]) / 100})
    coll: dict[str, dict] = {}
    for r in ok:
        c = coll.setdefault(r["saisi_par"] or "?", {"nom": r["saisi_par"] or "?", "nb": 0, "especes": 0, "cheque": 0, "cb": 0})
        c["nb"] += 1
        c[r["mode"]] += round(r["montant"] * 100)
    collecteurs = sorted(({**c, "especes": c["especes"] / 100, "cheque": c["cheque"] / 100, "cb": c["cb"] / 100,
                           "total": (c["especes"] + c["cheque"] + c["cb"]) / 100} for c in coll.values()),
                         key=lambda c: -c["total"])
    # chaîne des espèces et chèques : terrain -> trésorier -> banque
    depots_all = db.list_depots(annee, avec_annules=True)
    depots = [d for d in depots_all if not d["annule_le"]]
    enc = {"especes": synth["especes"], "cheques": synth["cheque"], "nb_cheques": synth["nb_cheque"]}
    sumr = lambda rows, k: sum(x[k] for x in rows) / 100  # noqa: E731
    # dons hors tournée : déjà entre les mains du trésorier, comptés comme remis (et confirmés)
    direct = {"especes": cents([r for r in annexes if r["mode"] == "especes"]) / 100,
              "cheques": cents([r for r in annexes if r["mode"] == "cheque"]) / 100,
              "nb_cheques": sum(1 for r in annexes if r["mode"] == "cheque")}
    remis = {"especes": round(sumr(remises, "especes_cents") + direct["especes"], 2), "cheques": round(sumr(remises, "cheques_cents") + direct["cheques"], 2),
             "nb_cheques": sum(r["nb_cheques"] for r in remises) + direct["nb_cheques"]}
    conf = [r for r in remises if r["confirme_le"]]
    remis_conf = {"especes": round(sumr(conf, "especes_cents") + direct["especes"], 2), "cheques": round(sumr(conf, "cheques_cents") + direct["cheques"], 2),
                  "nb_cheques": sum(r["nb_cheques"] for r in conf) + direct["nb_cheques"]}
    depose = {"especes": sumr(depots, "especes_cents"), "cheques": sumr(depots, "cheques_cents"), "nb_cheques": sum(d["nb_cheques"] for d in depots)}
    diff = lambda a, b: {k: round(a[k] - b[k], 2) for k in a}  # noqa: E731
    ok_dates = [r["created_at"] for r in ok]
    asso = {k: db.get_setting(f"asso_{k}", "") or "" for k in ("nom", "adresse", "siret")}
    return {
        "annee": annee, "annees": sorted(set(db.list_annees()) | {annee}, reverse=True), "edite_le": db._now(),
        "association": asso, "cloture": db.active_cloture(annee), "clotures": db.list_clotures(annee),
        "periode": {"debut": min(ok_dates) if ok_dates else None, "fin": max(ok_dates) if ok_dates else None},
        "synthese": synth, "maisons": maisons, "jours": jours, "secteurs": secteurs, "collecteurs": collecteurs,
        "chaine": {"encaisse": enc, "remis": remis, "remis_confirme": remis_conf, "depose": depose, "direct": direct,
                   "reste_terrain": diff(enc, remis), "reste_tresorier": diff(remis, depose),
                   "carte": {"total": synth["cb"], "nb": synth["nb_cb"]}},
        "remises": [{**{k: r[k] for k in ("id", "remis_par", "recu_par", "note", "created_at", "confirme_le", "annule_le", "annule_par", "nb_cheques")},
                     "secteur": labels.get(r["sector_id"], ""), "especes": r["especes_cents"] / 100, "cheques": r["cheques_cents"] / 100,
                     "ecart_especes": (r["especes_cents"] - r["attendu_especes_cents"]) / 100,
                     "ecart_cheques": (r["cheques_cents"] - r["attendu_cheques_cents"]) / 100} for r in remises_all],
        "depots": [{**{k: d[k] for k in ("id", "date_depot", "nb_cheques", "reference", "note", "par", "created_at", "annule_le", "annule_par")},
                    "especes": d["especes_cents"] / 100, "cheques": d["cheques_cents"] / 100} for d in depots_all],
        "registre": reg,
    }


@app.get("/api/admin/fiscal", dependencies=[Depends(auth.require("dons"))])
def admin_fiscal(annee: int | None = None):
    return _fiscal(annee or _annee())


def _download(content: bytes, filename: str, media: str = "text/csv; charset=utf-8") -> Response:
    return Response(content, media_type=media, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/admin/fiscal/registre.csv", dependencies=[Depends(auth.require("dons"))])
def admin_fiscal_register_csv(request: Request, annee: int | None = None):
    annee = annee or _annee()
    _log(request, "export", f"registre des dons {annee}")
    return _download(_registre_csv(annee), f"registre-dons-{annee}.csv")


@app.get("/api/admin/fiscal/caisse.csv", dependencies=[Depends(auth.require("dons"))])
def admin_fiscal_cash_csv(annee: int | None = None):
    f = _fiscal(annee or _annee())
    rows = [["Date", "Nombre de dons", "Espèces (€)", "Chèques (€)", "Carte (€)", "Total du jour (€)", "Cumul (€)"]]
    for j in f["jours"]:
        rows.append([dt.date.fromisoformat(j["date"]).strftime("%d/%m/%Y"), j["nb"], _money(j["especes"]), _money(j["cheque"]),
                     _money(j["cb"]), _money(j["total"]), _money(j["cumul"])])
    s_ = f["synthese"]
    rows.append(["Total", s_["nb"], _money(s_["especes"]), _money(s_["cheque"]), _money(s_["cb"]), _money(s_["total"]), ""])
    return _download(_csv(rows), f"journal-caisse-{f['annee']}.csv")


@app.post("/api/admin/depots", dependencies=[Depends(auth.require("dons"))])
def admin_add_deposit(payload: DepotIn, request: Request):
    annee = payload.annee or _annee()
    _check_open(annee)
    if payload.especes == 0 and payload.cheques == 0:
        raise HTTPException(status_code=422, detail="Indiquez le montant déposé")
    d = db.add_depot({"annee": annee, "date_depot": payload.date_depot.isoformat(), "especes_cents": round(payload.especes * 100),
                      "cheques_cents": round(payload.cheques * 100), "nb_cheques": payload.nb_cheques,
                      "reference": payload.reference, "note": payload.note, "par": _actor(request)[0]})
    _log(request, "depot.ajout", f"dépôt du {payload.date_depot.strftime('%d/%m/%Y')}",
         f"{_euros(d['especes_cents'])} espèces + {_euros(d['cheques_cents'])} chèques ({d['nb_cheques']})"
         f"{' · bordereau ' + d['reference'] if d['reference'] else ''}")
    return d


@app.delete("/api/admin/depots/{depot_id}", dependencies=[Depends(auth.require("dons"))])
def admin_cancel_deposit(depot_id: int, request: Request):
    d = db.get_depot(depot_id)
    if not d or d["annule_le"]:
        raise HTTPException(status_code=404, detail="Dépôt inconnu")
    _check_open(d["annee"])
    db.cancel_depot(depot_id, _actor(request)[0])
    _log(request, "depot.annulation", f"dépôt du {dt.date.fromisoformat(d['date_depot']).strftime('%d/%m/%Y')}",
         f"{_euros(d['especes_cents'])} espèces + {_euros(d['cheques_cents'])} chèques")
    return {"ok": True}


def _clotures_dir() -> str:
    path = os.path.join(db.backup_dir(), "clotures")
    os.makedirs(path, exist_ok=True)
    return path


@app.post("/api/admin/fiscal/cloture", dependencies=[Depends(auth.require("dons"))])
def admin_close_year(payload: ClotureIn, request: Request):
    """Clôture : les montants de l'année sont figés et le registre est archivé avec son empreinte SHA-256."""
    if db.active_cloture(payload.annee):
        raise HTTPException(status_code=409, detail="Cette année est déjà clôturée")
    pending = [r for r in _registre(payload.annee) if r["statut"] == "attente"]
    if pending:
        raise HTTPException(status_code=409, detail=f"{len(pending)} paiement(s) carte encore en attente : validez-les ou annulez-les d'abord")
    content = _registre_csv(payload.annee)
    digest = hashlib.sha256(content).hexdigest()
    name = f"registre-dons-{payload.annee}-cloture-{dt.datetime.now(PARIS).strftime('%Y%m%d-%H%M%S')}.csv"
    with open(os.path.join(_clotures_dir(), name), "wb") as fh:
        fh.write(content)
    s_ = _fiscal(payload.annee)["synthese"]
    c = db.add_cloture({"annee": payload.annee, "par": _actor(request)[0], "nb_dons": s_["nb"],
                        "total_cents": round(s_["total"] * 100), "sha256": digest, "fichier": name})
    db.make_backup("cloture")
    _log(request, "cloture", f"tournée {payload.annee}", f"{s_['nb']} dons · {_euros(c['total_cents'])} · empreinte {digest[:16]}…")
    return c


@app.post("/api/admin/fiscal/cloture/{cloture_id}/reouvrir", dependencies=[Depends(auth.require("comptes"))])
def admin_reopen_year(cloture_id: int, payload: ReouvertureIn, request: Request):
    c = next((x for x in db.list_clotures() if x["id"] == cloture_id), None)
    if not c or c["rouvert_le"]:
        raise HTTPException(status_code=404, detail="Clôture inconnue ou déjà rouverte")
    db.reopen_cloture(cloture_id, _actor(request)[0], " ".join(payload.motif.split()))
    _log(request, "cloture.reouverture", f"tournée {c['annee']}", f"motif : {payload.motif}")
    return {"ok": True}


@app.get("/api/admin/fiscal/archive/{cloture_id}", dependencies=[Depends(auth.require("dons"))])
def admin_close_archive(cloture_id: int):
    c = next((x for x in db.list_clotures() if x["id"] == cloture_id), None)
    path = os.path.join(_clotures_dir(), c["fichier"]) if c else ""
    if not c or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Archive introuvable")
    with open(path, "rb") as fh:
        return _download(fh.read(), c["fichier"])


@app.get("/api/admin/dons", dependencies=[Depends(auth.require("dons"))])
def admin_dons():
    labels = {}
    for slug in _all_slugs():
        labels.update({a["id"]: _full_label(a) for a in _addresses(slug, _load_commune(slug))})
    return {"annee": _annee(), "dons": [
        {**_don_view(d, True, None), "sector_id": d["sector_id"], "slug": d["commune_slug"],
         "adresse": ORIGINES.get(d["origine"], ANNEXE_LABEL) if d["sector_id"] == ANNEXE else labels.get(d["address_id"], d["address_id"])}
        for d in db.list_dons(_annee())
    ]}


# ---- Dons hors tournée (adresse inconnue, boîte aux lettres de la caserne…) ----------------

def _annexe_view(d: dict) -> dict:
    return {"id": d["id"], "numero": d["numero"], "montant": d["montant_cents"] / 100, "mode": d["mode"],
            "origine": d["origine"], "origine_label": ORIGINES.get(d["origine"], ""), "note": d["note"],
            "tx_code": d["tx_code"], "par": d["personne_nom"], "created_at": d["created_at"],
            "annule_le": d["annule_le"], "annule_par": d["annule_par"], "motif": d["motif"]}


@app.get("/api/admin/dons-annexes", dependencies=[Depends(auth.require("dons"))])
def admin_annex_list():
    dons = [d for d in db.list_dons(_annee(), avec_annules=True) if d["sector_id"] == ANNEXE]
    return {"annee": _annee(), "origines": ORIGINES, "dons": [_annexe_view(d) for d in reversed(dons)],
            "totaux": _totaux([d for d in dons if not d["annule_le"]])}


@app.post("/api/admin/dons-annexes", dependencies=[Depends(auth.require("dons"))])
def admin_annex_add(payload: DonAnnexeIn, request: Request):
    """Don reçu hors tournée : il entre au registre (numéroté) et dans tous les totaux ; l'argent
    est déjà chez le trésorier (pas de remise de caisse)."""
    _check_open(_annee())
    qui = _actor(request)[0]
    don, _ = db.add_don({
        "annee": _annee(), "commune_slug": "", "address_id": "", "sector_id": ANNEXE,
        "montant_cents": round(payload.montant * 100), "mode": payload.mode, "statut": "ok",
        "tx_code": payload.tx_code, "note": payload.note, "personne_nom": qui, "origine": payload.origine,
    })
    _log(request, "don.annexe", f"{ANNEXE_LABEL} · {ORIGINES[payload.origine]}",
         f"n° {don['numero']} · {_euros(don['montant_cents'])} {MODE_FR[don['mode']]}{' · ' + payload.note if payload.note else ''}")
    return _annexe_view(don)


@app.delete("/api/admin/dons-annexes/{don_id}", dependencies=[Depends(auth.require("dons"))])
def admin_annex_cancel(don_id: int, request: Request, motif: str = ""):
    """Annule un don hors tournée (erreur de saisie) : il reste au registre, avec le motif."""
    don = db.get_don(don_id)
    if not don or don["sector_id"] != ANNEXE or don["annule_le"]:
        raise HTTPException(status_code=404, detail="Don inconnu")
    _check_open(don["annee"])
    motif = " ".join(motif.split())[:200] or "annulé sans motif"
    db.cancel_don(don["id"], _actor(request)[0], motif)
    _log(request, "don.suppression", f"{ANNEXE_LABEL} · {ORIGINES.get(don['origine'], '')}",
         f"n° {don['numero']} · {_euros(don['montant_cents'])} {MODE_FR[don['mode']]} · motif : {motif}")
    return {"ok": True}


@app.put("/api/admin/secteurs/{sector_id}/equipe", dependencies=[Depends(auth.require("equipes"))])
def admin_set_equipe(sector_id: int, payload: EquipeIn, request: Request):
    if sector_id not in db.existing_sector_ids():
        raise HTTPException(status_code=404, detail="Secteur inconnu (a-t-il été supprimé ?)")
    known = {p["id"] for p in db.list_personnes()}
    unknown = [m.personne_id for m in payload.membres if m.personne_id not in known]
    if unknown:
        raise HTTPException(status_code=404, detail="Personne inconnue dans l'équipe")
    plan = payload.model_dump(exclude={"membres"})
    before = db.get_teams().get(sector_id) or {"date": "", "creneau": "", "statut": "a_faire", "note": "", "membres": []}
    db.set_team(sector_id, plan, [m.model_dump() for m in payload.membres])
    db.touch_personnes([m.personne_id for m in payload.membres])
    after = db.get_teams().get(sector_id)
    names = {p["id"]: p["nom"] for p in db.list_personnes()}
    fmt = lambda t: {f"{names.get(m['personne_id'], '?')}{' ★' if m['role'] == 'responsable' else ''}" for m in t["membres"]}  # noqa: E731
    changes = [f"+ {n}" for n in sorted(fmt(after) - fmt(before))] + [f"− {n}" for n in sorted(fmt(before) - fmt(after))]
    for k, label in (("date", "date"), ("creneau", "créneau"), ("statut", "avancement"), ("note", "consignes")):
        if before[k] != after[k]:
            changes.append(f"{label} : {STATUT_FR.get(before[k], before[k]) or '—'} → {STATUT_FR.get(after[k], after[k]) or '—'}")
    if changes:
        _log(request, "equipe.modif", _sector_label(sector_id), " · ".join(changes))
    return after


@app.get("/api/admin/communes/{slug}", dependencies=[Depends(auth.require("secteurs"))])
def admin_get_commune(slug: str):
    data = _load_commune(slug)
    return {
        "commune": data["commune"],
        "sectors": _sectors_with_limits(slug, data, "secteur"),
        "addresses": _addresses(slug, data),
        "excluded": sorted(db.get_excluded(slug)),
        "roads": data.get("roads", []),
        "buildings": data.get("buildings", []),
        "auto_sectors": [
            {k: s[k] for k in ("nom", "couleur", "polygon", "nb_adresses")}
            for s in data.get("auto_sectors", []) if len(s.get("polygon", [])) >= 3
        ],
    }


def _sectors_impact(slug: str, data: dict, payload: SectorsIn) -> dict:
    """Ce que changerait l'enregistrement de ces secteurs pour les maisons déjà passées cette année :
    celles qui changent de secteur (avec leur statut, leurs dons) et les secteurs supprimés."""
    addresses = _active_addresses(slug, data)
    current = _sectors(slug, data)
    old_by, _ = _assign(addresses, current)
    old_of = {a["id"]: sid for sid, lst in old_by.items() for a in lst}
    ent = [s for s in current if s["kind"] == "entreprises"]  # les entreprises restent dans leur tournée
    current = [s for s in current if s["kind"] == "secteur"]
    known = {s["id"] for s in current}
    proposed = ent + [{"id": x.id if x.id in known else f"nouveau-{i}", "nom": x.nom, "polygon": x.polygon}
                      for i, x in enumerate(payload.sectors)]
    new_by, _ = _assign(addresses, proposed)
    new_of = {a["id"]: sid for sid, lst in new_by.items() for a in lst}
    names = {s["id"]: s["nom"] for s in current} | {s["id"]: s["nom"] for s in proposed}
    statuses = db.get_statuses(slug)
    notes = db.get_notes(slug)
    dons_by: dict[str, list[dict]] = {}
    all_dons = [d for d in db.list_dons(_annee()) if d["commune_slug"] == slug]
    for d in all_dons:
        dons_by.setdefault(d["address_id"], []).append(d)
    labels = {a["id"]: a["label"] for a in addresses}
    maisons, deplacees = [], 0
    for aid in sorted(set(old_of) | set(new_of), key=lambda x: labels.get(x, x)):
        de, vers = old_of.get(aid), new_of.get(aid)
        if de == vers:
            continue
        deplacees += 1
        st = (statuses.get(aid) or {}).get("status")
        dons = [d for d in dons_by.get(aid, []) if d["statut"] == "ok"]
        if not (st or dons or aid in notes):
            continue
        maisons.append({"address_id": aid, "label": labels.get(aid, aid),
                        "de": names.get(de, "hors secteur"), "vers": names.get(vers, "hors secteur"),
                        "status": st, "note": aid in notes, "nb_dons": len(dons),
                        "montant": sum(d["montant_cents"] for d in dons) / 100})
    kept = {x.id for x in payload.sectors if x.id in known}
    teams = db.get_teams()
    supprimes = []
    for sec in current:
        if sec["id"] in kept:
            continue
        dons = [d for d in all_dons if d["sector_id"] == sec["id"] and d["statut"] == "ok"]
        supprimes.append({"id": sec["id"], "nom": sec["nom"], "membres": len((teams.get(sec["id"]) or {}).get("membres", [])),
                          "nb_dons": len(dons), "montant": sum(d["montant_cents"] for d in dons) / 100})
    return {"deplacees": deplacees, "maisons": maisons, "supprimes": supprimes}


@app.post("/api/admin/communes/{slug}/sectors/impact", dependencies=[Depends(auth.require("secteurs"))])
def admin_sectors_impact(slug: str, payload: SectorsIn):
    return _sectors_impact(slug, _load_commune(slug), payload)


@app.put("/api/admin/communes/{slug}/sectors", dependencies=[Depends(auth.require("secteurs"))])
def admin_save_sectors(slug: str, payload: SectorsIn, request: Request):
    data = _load_commune(slug)
    impact = _sectors_impact(slug, data, payload)
    db.replace_sectors(slug, [s.model_dump() for s in payload.sectors])
    _log(request, "secteurs.enregistres", data["commune"]["nom"], f"{len(payload.sectors)} secteur(s) : " + ", ".join(x.nom for x in payload.sectors)[:300])
    if impact["maisons"]:
        # trace de ce que les maisons déjà passées sont devenues (statut et dons ne bougent pas : ils suivent la maison)
        items = [f"{m['label']} ({m['de']} → {m['vers']}" + (f", {STATUS_FR.get(m['status'], m['status'])}" if m["status"] else "")
                 + (f", {m['nb_dons']} don(s) {_euros(round(m['montant'] * 100))}" if m["nb_dons"] else "") + ")"
                 for m in impact["maisons"]]
        chunks, cur = [], ""
        for it in items:  # le journal garde 500 caractères par ligne : plusieurs lignes si besoin
            if cur and len(cur) + len(it) + 2 > 480:
                chunks.append(cur)
                cur = ""
            cur = f"{cur}; {it}" if cur else it
        chunks.append(cur)
        for i, chunk in enumerate(chunks):
            head = f"{len(items)} maison(s) déjà passée(s) changent de secteur" if i == 0 else "suite"
            _log(request, "secteurs.maisons", data["commune"]["nom"], f"{head} : {chunk}")
    for sec in impact["supprimes"]:
        if sec["membres"] or sec["nb_dons"]:
            _log(request, "secteurs.supprime", data["commune"]["nom"],
                 f"{sec['nom']} : équipe de {sec['membres']} personne(s) retirée, {sec['nb_dons']} don(s) "
                 f"{_euros(round(sec['montant'] * 100))} gardés au registre")
    return {"sectors": _sectors_with_limits(slug, data, "secteur")}


@app.put("/api/admin/communes/{slug}/excluded", dependencies=[Depends(auth.require("secteurs"))])
def admin_set_excluded(slug: str, payload: ExclusionIn, request: Request):
    data = _load_commune(slug)
    known = _address_ids(slug, data)
    unknown = [a for a in payload.address_ids if a not in known]
    if unknown:
        raise HTTPException(status_code=404, detail=f"Adresse(s) inconnue(s) : {', '.join(unknown[:5])}")
    db.set_excluded(slug, payload.address_ids, payload.excluded)
    _log(request, "adresses.exclues" if payload.excluded else "adresses.reintegrees", data["commune"]["nom"],
         ", ".join(_addr_label(slug, a) for a in payload.address_ids[:10]) + (f" (+{len(payload.address_ids) - 10})" if len(payload.address_ids) > 10 else ""))
    return {"excluded": sorted(db.get_excluded(slug))}


@app.get("/api/admin/communes/{slug}/versions", dependencies=[Depends(auth.require("secteurs"))])
def admin_list_versions(slug: str):
    _load_commune(slug)
    return {"versions": db.list_versions(slug)}


@app.get("/api/admin/communes/{slug}/versions/{version_id}", dependencies=[Depends(auth.require("secteurs"))])
def admin_get_version(slug: str, version_id: int):
    _load_commune(slug)
    sectors = db.get_version(slug, version_id)
    if sectors is None:
        raise HTTPException(status_code=404, detail="Version inconnue")
    return {"sectors": sectors}


@app.post("/api/admin/communes/{slug}/reset-statuses", dependencies=[Depends(auth.require("suivi"))])
def admin_reset_statuses(slug: str, request: Request):
    data = _load_commune(slug)
    db.reset_statuses(slug)
    _log(request, "statuts.remise_a_zero", data["commune"]["nom"], f"tournée {_annee()}")
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


@app.get("/mentions", include_in_schema=False)
@app.get("/mentions.html", include_in_schema=False)
def legal_page():
    return _page("mentions.html")


@app.get("/recu/{token}", include_in_schema=False)
def receipt_page(token: str):
    return _page("recu.html")


@app.get("/fiscal.html", include_in_schema=False)
def fiscal_page():
    return _page("fiscal.html")


# ---- Version multi-casernes : admin central et choix de la caserne selon l'adresse --------

app.include_router(central.router)


@app.get("/plateforme", include_in_schema=False)
def central_page():
    return _page("plateforme.html", brand=False)


@app.get("/logo", include_in_schema=False)
def caserne_logo():
    """Logo envoyé par la caserne (gardé dans sa base, donc dans ses sauvegardes)."""
    data = db.get_setting("caserne_logo", "")
    if not data:
        return RedirectResponse(_branding()["logo"])
    kind = db.get_setting("caserne_logo_type", "image/png")
    headers = {"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"}
    if kind == "image/svg+xml":  # une image SVG ne doit jamais exécuter de script
        headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    return Response(base64.b64decode(data), media_type=kind, headers=headers)


@app.put("/api/admin/logo", dependencies=[Depends(auth.require("reglages"))])
def admin_set_logo(payload: LogoIn, request: Request):
    try:
        raw = base64.b64decode(payload.data, validate=True)
    except ValueError:
        raise HTTPException(status_code=422, detail="Image illisible")
    if len(raw) > 1_000_000:
        raise HTTPException(status_code=413, detail="Image trop lourde (1 Mo au plus)")
    signatures = {"image/png": raw[:8] == b"\x89PNG\r\n\x1a\n", "image/jpeg": raw[:3] == b"\xff\xd8\xff",
                  "image/webp": raw[:4] == b"RIFF" and raw[8:12] == b"WEBP",
                  "image/svg+xml": b"<svg" in raw[:2000].lower()}
    if not signatures[payload.type]:
        raise HTTPException(status_code=422, detail="Le fichier ne correspond pas à une image PNG, JPEG, WebP ou SVG")
    db.set_setting("caserne_logo", base64.b64encode(raw).decode())
    db.set_setting("caserne_logo_type", payload.type)
    db.set_setting("caserne_logo_v", hashlib.sha1(raw).hexdigest()[:10])
    _log(request, "reglages", "logo", f"nouveau logo ({payload.type}, {len(raw) // 1024} Ko)")
    return {"logo": _branding()["logo"]}


@app.delete("/api/admin/logo", dependencies=[Depends(auth.require("reglages"))])
def admin_delete_logo(request: Request):
    for k in ("caserne_logo", "caserne_logo_type", "caserne_logo_v"):
        db.set_setting(k, "")
    _log(request, "reglages", "logo", "logo d'origine rétabli")
    return {"logo": _branding()["logo"]}


# ---- Guide de démarrage d'une nouvelle caserne ---------------------------------------------

def _onboarding_state() -> dict:
    cas = plateforme.current.get()
    b = _branding()
    communes = []
    for slug in _all_slugs():
        data = _load_commune(slug)
        communes.append({"slug": slug, "nom": data["commune"]["nom"], "adresses": len(_active_addresses(slug, data)),
                         "secteurs": len(db.list_sectors(slug, "secteur")),
                         "proposes": sum(1 for x in data.get("auto_sectors", []) if len(x.get("polygon", [])) >= 3)})
    gen = plateforme.last_generation(cas.id) if cas is not None else None
    with db.get_conn() as conn:
        personnes = conn.execute("SELECT COUNT(*) FROM personnes").fetchone()[0]
    return {
        "multi": cas is not None, "fait": db.get_setting("demarrage_fait", "") == "1",
        "etapes": {
            "identite": b["logo_perso"],
            "association": bool(db.get_setting("asso_adresse", "") and (db.get_setting("contact_email", "") or db.get_setting("contact_tel", ""))),
            "communes": bool(communes),
            "secteurs": bool(communes) and all(c["secteurs"] for c in communes),
            "equipe": personnes > 0,
        },
        "communes": communes, "generation": gen["statut"] if gen else None,
        "annee": _annee(), "suivi": _suivi_enabled(), "dons": _flag("dons_actifs", False), "personnes": personnes,
    }


@app.get("/api/admin/demarrage", dependencies=[Depends(auth.require("reglages"))])
def admin_onboarding():
    return _onboarding_state()


@app.post("/api/admin/demarrage/secteurs", dependencies=[Depends(auth.require("secteurs"))])
def admin_onboarding_sectors(request: Request):
    """Crée les secteurs proposés automatiquement dans chaque commune qui n'en a pas encore
    (point de départ, à retoucher ensuite dans l'onglet Secteurs)."""
    created = []
    for slug in _all_slugs():
        data = _load_commune(slug)
        if db.list_sectors(slug, "secteur"):
            continue
        autos = [{"nom": x["nom"], "couleur": x["couleur"], "polygon": x["polygon"]}
                 for x in data.get("auto_sectors", []) if len(x.get("polygon", [])) >= 3]
        if not autos:
            continue
        db.replace_sectors(slug, autos)
        created.append(f"{data['commune']['nom']} ({len(autos)})")
    if created:
        _log(request, "secteurs.enregistres", "guide de démarrage", "secteurs proposés créés : " + ", ".join(created))
    return {**_onboarding_state(), "crees": created}


@app.post("/api/admin/demarrage/fin", dependencies=[Depends(auth.require("reglages"))])
def admin_onboarding_done(request: Request):
    db.set_setting("demarrage_fait", "1")
    _log(request, "reglages", "guide de démarrage", "terminé")
    return _onboarding_state()


@app.get("/manifest.webmanifest", include_in_schema=False)
def web_manifest():
    """Application installable aux nom et logo de la caserne."""
    b = _branding()
    base = json.loads((FRONTEND_DIR / "manifest.webmanifest").read_text(encoding="utf-8"))
    base["name"] = f"Tournée des calendriers — {b['nom']}"
    base["description"] = f"Secteurs de la tournée des calendriers — {b['nom']}" + (f" ({', '.join(b['communes'])})" if b["communes"] else "")
    base["theme_color"] = b["couleur"] if b["couleur"] != DEFAULT_COULEUR else base.get("theme_color", DEFAULT_COULEUR)
    if b["logo_perso"] or plateforme.current.get() is not None:
        kind = db.get_setting("caserne_logo_type", "image/svg+xml") if b["logo_perso"] else "image/svg+xml"
        base["icons"] = [{"src": b["logo"], "sizes": "any", "type": kind, "purpose": "any"}]
    return JSONResponse(base, media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


@app.get("/api/public/caserne")
def public_caserne():
    """Caserne du site (nom, état de l'abonnement si l'option est active)."""
    cas = plateforme.current.get()
    if cas is None:
        return {"multi": False}
    return {"multi": True, "slug": cas.slug, "nom": cas.nom, "abonnement": plateforme.abonnement_etat(cas)}


STATIC_PREFIXES = ("/css/", "/js/", "/img/", "/icons/", "/vendor/", "/favicon")


@app.get("/api/sante", include_in_schema=False)
def health():
    """Contrôle de santé du conteneur (répond quelle que soit l'adresse)."""
    return {"ok": True}


class CaserneMiddleware:
    """Choisit la caserne d'après le nom d'hôte et la garde pour toute la requête (base, données, sessions).
    Une adresse qui ne mène à aucune caserne ouvre l'admin central. Sans PLATFORM_DB_PATH : rien ne change."""

    def __init__(self, app):
        self.asgi = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not plateforme.enabled():
            return await self.asgi(scope, receive, send)
        host = dict(scope.get("headers") or []).get(b"host", b"").decode("latin-1")
        path = scope.get("path", "")
        central_path = path == "/plateforme" or path.startswith("/api/plateforme/")
        if path == "/api/sante":
            return await self.asgi(scope, receive, send)
        if plateforme.vitrine_host(host):  # almaneo.fr : le site vitrine
            if path in ("/", "/index.html"):
                return await _vitrine_page()(scope, receive, send)
            if path.startswith(STATIC_PREFIXES) or path == "/api/vitrine/demande":
                return await self.asgi(scope, receive, send)
            if path == "/plateforme" and plateforme.PLATFORM_DOMAIN:
                return await RedirectResponse(f"https://admin.{plateforme.PLATFORM_DOMAIN}/plateforme")(scope, receive, send)
            return await _plain(404, "Page introuvable.")(scope, receive, send)
        if path == "/api/vitrine/demande":
            return await _plain(404, "Introuvable.")(scope, receive, send)
        cas = await asyncio.to_thread(plateforme.resolve, host)
        if cas is None:
            if central_path or path.startswith(STATIC_PREFIXES):
                return await self.asgi(scope, receive, send)
            if path in ("/", "/index.html", "/admin", "/admin.html"):
                return await RedirectResponse("/plateforme")(scope, receive, send)
            return await _plain(404, "Aucune caserne à cette adresse.")(scope, receive, send)
        if central_path:
            return await _plain(404, "Introuvable.")(scope, receive, send)
        if cas.statut != "active":
            return await _plain(503, "Le site de cette caserne est suspendu. Contactez l'administrateur de la plateforme.")(scope, receive, send)
        token = plateforme.current.set(cas)
        try:
            await self.asgi(scope, receive, send)
        finally:
            plateforme.current.reset(token)


def _vitrine_page() -> HTMLResponse:
    """Site vitrine de la plateforme (almaneo.fr)."""
    esc = lambda v: v.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")  # noqa: E731
    name, mail, editeur = plateforme.PLATFORM_NAME, plateforme.PLATFORM_CONTACT_EMAIL, plateforme.PLATFORM_EDITEUR
    html = (FRONTEND_DIR / "vitrine.html").read_text(encoding="utf-8").replace("__V__", ASSET_VERSION)
    html = (html.replace("__NOM__", esc(name))
            .replace("__CONTACT__", f'<a href="mailto:{esc(mail)}">{esc(mail)}</a>' if mail else "le formulaire ci-dessus")
            .replace("__EDITEUR__", esc(editeur) if editeur else esc(name))
            .replace("__DOMAINE__", esc(plateforme.PLATFORM_DOMAIN or "almaneo.fr"))
            .replace("__ADMIN__", f"https://admin.{esc(plateforme.PLATFORM_DOMAIN)}/plateforme" if plateforme.PLATFORM_DOMAIN else "/plateforme"))
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


def _plain(code: int, message: str):
    return JSONResponse({"detail": message}, status_code=code)


app.add_middleware(CaserneMiddleware)


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
