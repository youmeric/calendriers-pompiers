"""Admin central de la plateforme multi-casernes : créer et gérer les casernes.

Joignable à l'adresse de l'admin central (admin.<domaine>, ou toute adresse qui ne mène à aucune
caserne), sous /plateforme. Compte : PLATFORM_ADMIN_PASSWORD (variable d'environnement)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

from . import auth, db, plateforme

router = APIRouter()
COOKIE = "plateforme_session"
SESSION_SECONDS = 12 * 3600
PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR") or Path(__file__).resolve().parents[2] / "data_pipeline")


# ---- Connexion de l'admin central ------------------------------------------------------------

def _password() -> str | None:
    return os.environ.get("PLATFORM_ADMIN_PASSWORD") or None


def _secret() -> bytes:
    s = os.environ.get("SECRET_KEY")
    if not s:
        s = plateforme.get_reglage("secret")
        if not s:
            s = os.urandom(32).hex()
            plateforme.set_reglage("secret", s)
    return hmac.new(s.encode(), b"plateforme", hashlib.sha256).digest()


PRINCIPAL = "Administrateur principal"


def _version(account: dict | None) -> str:
    """Changer le mot de passe (ou désactiver le compte) déconnecte ses sessions."""
    basis = (_password() or "") if account is None else f"{account['mdp']}:{account['actif']}"
    return hashlib.sha256(basis.encode()).hexdigest()[:10]


def _sign(aid: int, version: str, expires: int) -> str:
    return hmac.new(_secret(), f"central:{aid}:{version}:{expires}".encode(), hashlib.sha256).hexdigest()


def current_user(request: Request) -> dict | None:
    """Compte de l'admin central connecté : {id (0 = principal), nom}."""
    if hasattr(request.state, "central_user"):
        return request.state.central_user
    user = None
    parts = (request.cookies.get(COOKIE) or "").split(".")
    if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit() and int(parts[1]) > time.time():
        aid, expires = int(parts[0]), int(parts[1])
        account = None if aid == 0 else plateforme.get_compte(aid)
        ok_account = (aid == 0 and _password()) or (account and account["actif"])
        if ok_account and hmac.compare_digest(parts[2], _sign(aid, _version(account), expires)):
            user = {"id": 0, "nom": PRINCIPAL} if aid == 0 else {"id": account["id"], "nom": account["nom"]}
    request.state.central_user = user
    return user


def require_central(request: Request) -> None:
    if not current_user(request):
        raise HTTPException(status_code=401, detail="Connexion à l'admin central requise")


def _who(request: Request) -> str:
    u = current_user(request)
    return u["nom"] if u else "?"


class LoginIn(BaseModel):
    identifiant: str = Field(default="", max_length=60)
    password: str = Field(min_length=1, max_length=200)


@router.post("/api/plateforme/login")
def login(payload: LoginIn, request: Request, response: Response):
    ip = auth.client_ip(request)
    if auth.too_many_attempts(ip):
        raise HTTPException(status_code=429, detail="Trop d'essais : réessayez dans quelques minutes")
    ident = payload.identifiant.strip()
    account = None
    if not ident:  # compte principal (mot de passe de l'installation)
        if not _password():
            raise HTTPException(status_code=503, detail="PLATFORM_ADMIN_PASSWORD n'est pas configuré sur le serveur")
        ok = hmac.compare_digest(payload.password.encode(), _password().encode())
    else:
        account = plateforme.compte_par_identifiant(ident)
        ok = bool(account) and auth.verify_password(payload.password, account["mdp"])
    if not ok:
        auth.record_failure(ip)
        plateforme.log(ident or "?", "connexion.echec", "", f"adresse {ip}")
        time.sleep(1)
        raise HTTPException(status_code=401, detail="Identifiant ou mot de passe incorrect")
    if account and not account["actif"]:
        raise HTTPException(status_code=403, detail="Ce compte est désactivé")
    aid = account["id"] if account else 0
    expires = int(time.time()) + SESSION_SECONDS
    response.set_cookie(COOKIE, f"{aid}.{expires}.{_sign(aid, _version(account), expires)}", max_age=SESSION_SECONDS,
                        httponly=True, samesite="strict", secure=auth.COOKIE_SECURE)
    plateforme.log(account["nom"] if account else PRINCIPAL, "connexion")
    return {"ok": True}


@router.post("/api/plateforme/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/api/plateforme/moi", dependencies=[Depends(require_central)])
def me(request: Request):
    return {"ok": True, "moi": current_user(request), "domaine": plateforme.PLATFORM_DOMAIN, "abonnements_actifs": plateforme.abonnements_actifs()}


# ---- Casernes ----------------------------------------------------------------------------------

class CommuneIn(BaseModel):
    nom: str = Field(min_length=1, max_length=80)
    code_postal: str = Field(pattern=r"^\d{5}$")

    @field_validator("nom")
    @classmethod
    def strip(cls, v: str) -> str:
        return " ".join(v.split())


class CaserneIn(BaseModel):
    slug: str = Field(min_length=2, max_length=40)
    nom: str = Field(min_length=1, max_length=120)
    hosts: list[str] = Field(default_factory=list, max_length=10)
    admin_identifiant: str = Field(min_length=2, max_length=60, pattern=r"^[A-Za-z0-9._@\-]+$")
    admin_nom: str = Field(min_length=1, max_length=80)
    admin_password: str = Field(min_length=8, max_length=200)
    communes: list[CommuneIn] = Field(default_factory=list, max_length=20)

    @field_validator("slug")
    @classmethod
    def check_slug(cls, v: str) -> str:
        v = v.strip().lower()
        if not plateforme.SLUG_RE.match(v) or v in plateforme.RESERVED:
            raise ValueError("identifiant de caserne : lettres minuscules, chiffres et tirets (ex. « courzieu »)")
        return v


class CaserneUpdate(BaseModel):
    nom: str | None = Field(default=None, min_length=1, max_length=120)
    # bot WhatsApp : envoi des accès activé pour cette caserne, et bot propre (facultatif ; vide = celui de la plateforme)
    whatsapp_actif: bool | None = None
    whatsapp_url: str | None = Field(default=None, max_length=300)
    whatsapp_key: str | None = Field(default=None, max_length=200)
    statut: str | None = None
    hosts: list[str] | None = Field(default=None, max_length=10)
    abonnement: str | None = None
    abonnement_fin: str | None = Field(default=None, pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    note: str | None = Field(default=None, max_length=500)


class CompteIn(BaseModel):
    identifiant: str = Field(min_length=2, max_length=60, pattern=r"^[A-Za-z0-9._@\-]+$")
    nom: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=200)


def _check_hosts(hosts: list[str], caserne_id: int | None) -> list[str]:
    out = []
    for h in hosts:
        h = plateforme.clean_host(h)
        if not h:
            continue
        owner = plateforme.host_owner(h)
        if owner is not None and owner != caserne_id:
            raise HTTPException(status_code=409, detail=f"L'adresse {h} mène déjà à une autre caserne")
        out.append(h)
    return out


def _url(cas: plateforme.Caserne) -> str | None:
    hs = plateforme.hosts(cas.id)
    if hs:
        return f"https://{hs[0]}/"
    return f"https://{cas.slug}.{plateforme.PLATFORM_DOMAIN}/" if plateforme.PLATFORM_DOMAIN else None


def _stats(cas: plateforme.Caserne) -> dict:
    """Quelques chiffres de la caserne, lus dans sa propre base."""
    with plateforme.use(cas):
        size = os.path.getsize(cas.db_path) if os.path.exists(cas.db_path) else 0
        with db.get_conn() as conn:
            one = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
            annee = db.current_annee()
            stats = {
                "comptes": one("SELECT COUNT(*) FROM comptes"),
                "personnes": one("SELECT COUNT(*) FROM personnes"),
                "secteurs": one("SELECT COUNT(*) FROM sectors WHERE kind = 'secteur'"),
                "dons": one(f"SELECT COUNT(*) FROM dons WHERE annee = {int(annee)} AND annule_le IS NULL AND statut = 'ok'"),
                "total": one(f"SELECT COALESCE(SUM(montant_cents), 0) FROM dons WHERE annee = {int(annee)} AND annule_le IS NULL AND statut = 'ok'") / 100,
                "derniere_activite": one("SELECT MAX(at) FROM journal"),
                "annee": annee,
            }
        backups = db.list_backups()
        stats["derniere_sauvegarde"] = backups[0]["date"] if backups else None
        communes = []
        index = Path(cas.data_dir) / "index.json"
        if index.exists():
            communes = [c["nom"] for c in json.loads(index.read_text(encoding="utf-8")).get("communes", [])]
    return {**stats, "communes": communes, "taille_base": size}


def _view(cas: plateforme.Caserne) -> dict:
    bot = plateforme.bot_settings(cas.id)
    return {"id": cas.id, "slug": cas.slug, "nom": cas.nom, "statut": cas.statut, "hosts": plateforme.hosts(cas.id),
            "whatsapp": {"actif": bot["actif"], "url": bot["url"], "key_set": bool(bot["key"])},
            "url": _url(cas), "abonnement": plateforme.abonnement_etat(cas),
            "abonnement_formule": cas.abonnement, "abonnement_fin": cas.abonnement_fin,
            "generation": plateforme.last_generation(cas.id), "stats": _stats(cas)}


@router.get("/api/plateforme/casernes", dependencies=[Depends(require_central)])
def list_casernes():
    return {"casernes": [_view(c) for c in plateforme.list_casernes()], "abonnements_actifs": plateforme.abonnements_actifs()}


@router.post("/api/plateforme/casernes", dependencies=[Depends(require_central)])
def create_caserne(payload: CaserneIn, request: Request):
    if plateforme.get_by_slug(payload.slug):
        raise HTTPException(status_code=409, detail="Une caserne a déjà cet identifiant")
    hosts = _check_hosts(payload.hosts, None)
    cas = plateforme.create(payload.slug, payload.nom.strip(), hosts)
    with plateforme.use(cas):
        db.init_db()
        db.set_setting("asso_nom", payload.nom.strip())
        db.set_setting("caserne_nom", payload.nom.strip())
        role = next(r for r in db.list_roles() if r["fixe"])  # « Administrateur » : tous les droits
        db.add_compte(payload.admin_identifiant.strip(), payload.admin_nom.strip(), auth.hash_password(payload.admin_password), role["id"])
        db.log(f"Admin central ({_who(request)})", "console", "caserne.creation", payload.nom, f"compte administrateur « {payload.admin_identifiant} »")
    plateforme.log(_who(request), "caserne.creation", payload.nom, f"{payload.slug} · {', '.join(hosts) or 'pas d’adresse'}")
    if payload.communes:
        _start_generation(cas, [c.model_dump() for c in payload.communes])
    return _view(plateforme.get(cas.id))


def _get(caserne_id: int) -> plateforme.Caserne:
    cas = plateforme.get(caserne_id)
    if not cas:
        raise HTTPException(status_code=404, detail="Caserne inconnue")
    return cas


@router.put("/api/plateforme/casernes/{caserne_id}", dependencies=[Depends(require_central)])
def update_caserne(caserne_id: int, payload: CaserneUpdate, request: Request):
    cas = _get(caserne_id)
    fields = payload.model_dump(exclude_none=True)
    if "statut" in fields and fields["statut"] not in plateforme.STATUTS:
        raise HTTPException(status_code=422, detail="Statut inconnu")
    if "abonnement" in fields and fields["abonnement"] not in plateforme.ABONNEMENTS:
        raise HTTPException(status_code=422, detail="Formule inconnue")
    if "hosts" in fields:
        fields["hosts"] = _check_hosts(fields["hosts"], caserne_id)
    if fields.get("abonnement_fin") == "":
        fields["abonnement_fin"] = None
    plateforme.set_bot(caserne_id, fields.pop("whatsapp_actif", None), fields.pop("whatsapp_url", None), fields.pop("whatsapp_key", None))
    new = plateforme.update(caserne_id, **fields)
    plateforme.log(_who(request), "caserne.modification", new.nom,
                   " · ".join(f"{k} : {'(modifiée)' if k == 'whatsapp_key' else v}" for k, v in payload.model_dump(exclude_none=True).items()))
    return _view(new)


@router.post("/api/plateforme/casernes/{caserne_id}/comptes", dependencies=[Depends(require_central)])
def add_admin_account(caserne_id: int, payload: CompteIn, request: Request):
    """Nouveau compte administrateur dans une caserne (ex. mot de passe perdu par son responsable)."""
    cas = _get(caserne_id)
    with plateforme.use(cas):
        if db.compte_login(payload.identifiant):
            raise HTTPException(status_code=409, detail="Cet identifiant existe déjà dans cette caserne")
        role = next(r for r in db.list_roles() if r["fixe"])
        acc = db.add_compte(payload.identifiant.strip(), payload.nom.strip(), auth.hash_password(payload.password), role["id"])
        db.log(f"Admin central ({_who(request)})", "console", "compte.ajout", acc["nom"], f"identifiant {acc['identifiant']} · rôle Administrateur")
    plateforme.log(_who(request), "compte.ajout", cas.nom, payload.identifiant)
    return {"ok": True}


# ---- Données des communes (pipeline : Base Adresse + OpenStreetMap) --------------------------

class CommunesIn(BaseModel):
    communes: list[CommuneIn] = Field(min_length=1, max_length=20)


_running: set[int] = set()


def _start_generation(cas: plateforme.Caserne, communes: list[dict]) -> int:
    if cas.id in _running:
        raise HTTPException(status_code=409, detail="Une génération est déjà en cours pour cette caserne")
    gid = plateforme.add_generation(cas.id, communes)
    _running.add(cas.id)

    def run():
        try:
            env = {**os.environ, "SECTORS_OUTPUT_DIR": cas.data_dir, "PIPELINE_COMMUNES": json.dumps(communes, ensure_ascii=False),
                   "BAN_CACHE_DIR": os.path.join(plateforme.CASERNES_DIR, "_cache")}
            p = subprocess.run([sys.executable, "run_pipeline.py"], cwd=PIPELINE_DIR, env=env, capture_output=True,
                               text=True, timeout=3600)
            ok = p.returncode == 0
            plateforme.end_generation(gid, ok, (p.stdout + p.stderr)[-2000:])
            plateforme.log("plateforme", "communes.generation", cas.nom, ("terminée" if ok else "échec") + " : "
                           + ", ".join(c["nom"] for c in communes))
        except Exception as err:  # noqa: BLE001
            plateforme.end_generation(gid, False, str(err))
        finally:
            _running.discard(cas.id)

    threading.Thread(target=run, daemon=True).start()
    return gid


@router.post("/api/plateforme/casernes/{caserne_id}/communes", dependencies=[Depends(require_central)])
def generate_communes(caserne_id: int, payload: CommunesIn):
    cas = _get(caserne_id)
    _start_generation(cas, [c.model_dump() for c in payload.communes])
    return {"generation": plateforme.last_generation(cas.id)}


# ---- Réglages de la plateforme et journal ------------------------------------------------------

class ReglagesIn(BaseModel):
    abonnements_actifs: bool | None = None
    whatsapp_bot_url: str | None = Field(default=None, max_length=300)
    whatsapp_bot_key: str | None = Field(default=None, max_length=200)


def _settings() -> dict:
    return {"abonnements_actifs": plateforme.abonnements_actifs(),
            "whatsapp_bot_url": plateforme.get_reglage("whatsapp_bot_url", ""),
            "whatsapp_bot_key_set": bool(plateforme.get_reglage("whatsapp_bot_key", ""))}


@router.get("/api/plateforme/reglages", dependencies=[Depends(require_central)])
def get_settings():
    return _settings()


@router.put("/api/plateforme/reglages", dependencies=[Depends(require_central)])
def save_settings(payload: ReglagesIn, request: Request):
    if payload.abonnements_actifs is not None:
        plateforme.set_reglage("abonnements_actifs", "1" if payload.abonnements_actifs else "0")
        plateforme.log(_who(request), "reglages", "abonnements", "activés" if payload.abonnements_actifs else "désactivés")
    if payload.whatsapp_bot_url is not None:
        plateforme.set_reglage("whatsapp_bot_url", payload.whatsapp_bot_url.strip())
        plateforme.log(_who(request), "reglages", "bot WhatsApp", payload.whatsapp_bot_url.strip() or "adresse effacée")
    if payload.whatsapp_bot_key is not None:
        plateforme.set_reglage("whatsapp_bot_key", payload.whatsapp_bot_key.strip())
        plateforme.log(_who(request), "reglages", "bot WhatsApp", "clé modifiée")
    return _settings()


@router.post("/api/plateforme/whatsapp/test", dependencies=[Depends(require_central)])
def test_bot():
    """Le bot de la plateforme répond-il, et WhatsApp est-il connecté ?"""
    from . import whatsapp
    url = plateforme.get_reglage("whatsapp_bot_url", "")
    if not url:
        return {"ok": False, "message": "Adresse du bot non réglée"}
    try:
        h = whatsapp.health(url, plateforme.get_reglage("whatsapp_bot_key", ""))
    except whatsapp.BotError as err:
        return {"ok": False, "message": str(err)}
    ready = bool(h.get("ready", h.get("ok")))
    return {"ok": ready, "message": "Bot connecté" if ready else "Le bot répond mais WhatsApp n'est pas connecté (QR à rescanner ?)"}


@router.get("/api/plateforme/journal", dependencies=[Depends(require_central)])
def central_journal():
    return {"entrees": plateforme.journal()}


# ---- Export et suppression d'une caserne ------------------------------------------------------

@router.get("/api/plateforme/casernes/{caserne_id}/export", dependencies=[Depends(require_central)])
def export_caserne(caserne_id: int, request: Request, background: BackgroundTasks):
    """Tout ce qu'il faut pour rendre ses données à une caserne ou la réinstaller ailleurs :
    sa base (copie cohérente), ses communes et ses informations sur la plateforme."""
    cas = _get(caserne_id)
    tmp = tempfile.mkdtemp(prefix="export-")
    zpath = os.path.join(tmp, f"caserne-{cas.slug}-{datetime.now().strftime('%Y-%m-%d')}.zip")
    snapshot = os.path.join(tmp, "status.db")
    with plateforme.use(cas):
        with db.get_conn() as src:
            dest = sqlite3.connect(snapshot)
            try:
                src.backup(dest)
            finally:
                dest.close()
    info = {"slug": cas.slug, "nom": cas.nom, "statut": cas.statut, "adresses": plateforme.hosts(cas.id),
            "abonnement": cas.abonnement, "abonnement_fin": cas.abonnement_fin,
            "exporte_le": datetime.now(timezone.utc).isoformat(), "exporte_par": _who(request)}
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(snapshot, "base/status.db")
        for f in sorted(Path(cas.data_dir).glob("*")) if os.path.isdir(cas.data_dir) else []:
            if f.is_file():
                z.write(f, f"communes/{f.name}")
        z.writestr("caserne.json", json.dumps(info, ensure_ascii=False, indent=2))
        z.writestr("LISEZMOI.txt", (
            f"Export complet de la caserne « {cas.nom} » ({cas.slug}), {info['exporte_le'][:10]}.\n\n"
            "base/status.db : toutes les données (secteurs, équipes, codes d'accès, suivi des maisons, dons,\n"
            "  registre, caisse, dépôts, clôtures, journal, réglages et logo) — base SQLite.\n"
            "communes/ : adresses et routes des communes (fichiers du pipeline).\n"
            "caserne.json : informations de la plateforme (adresses du site, statut, abonnement).\n\n"
            "Pour réinstaller : base/status.db comme DB_PATH et communes/ comme SECTORS_DATA_DIR d'une installation\n"
            "simple, ou en tant que caserne d'une plateforme (dossier casernes/<identifiant>/db et /sectors).\n"))
    background.add_task(shutil.rmtree, tmp, True)
    plateforme.log(_who(request), "caserne.export", cas.nom, os.path.basename(zpath))
    return FileResponse(zpath, media_type="application/zip", filename=os.path.basename(zpath))


@router.delete("/api/plateforme/casernes/{caserne_id}", dependencies=[Depends(require_central)])
def delete_caserne(caserne_id: int, request: Request, confirmation: str = ""):
    """Suppression définitive : seulement une caserne archivée, en retapant son identifiant."""
    cas = _get(caserne_id)
    if cas.statut != "archivee":
        raise HTTPException(status_code=409, detail="Archivez d'abord la caserne (et exportez ses données)")
    if confirmation.strip().lower() != cas.slug:
        raise HTTPException(status_code=422, detail=f"Tapez l'identifiant « {cas.slug} » pour confirmer")
    plateforme.delete_caserne(cas.id)
    shutil.rmtree(cas.dir, ignore_errors=True)
    plateforme.log(_who(request), "caserne.suppression", cas.nom, f"{cas.slug} : données effacées")
    return {"ok": True}


# ---- Comptes de l'admin central -------------------------------------------------------------

class CentralCompteIn(BaseModel):
    identifiant: str = Field(min_length=2, max_length=60, pattern=r"^[A-Za-z0-9._@\-]+$")
    nom: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=10, max_length=200)


class CentralCompteUpdate(BaseModel):
    nom: str | None = Field(default=None, min_length=1, max_length=80)
    password: str | None = Field(default=None, min_length=10, max_length=200)
    actif: bool | None = None


@router.get("/api/plateforme/comptes", dependencies=[Depends(require_central)])
def central_accounts():
    return {"comptes": plateforme.list_comptes()}


@router.post("/api/plateforme/comptes", dependencies=[Depends(require_central)])
def central_add_account(payload: CentralCompteIn, request: Request):
    if plateforme.compte_par_identifiant(payload.identifiant):
        raise HTTPException(status_code=409, detail="Cet identifiant existe déjà")
    acc = plateforme.add_compte(payload.identifiant, payload.nom, auth.hash_password(payload.password))
    plateforme.log(_who(request), "admin.ajout", acc["nom"], f"identifiant {acc['identifiant']}")
    return {k: v for k, v in acc.items() if k != "mdp"}


@router.put("/api/plateforme/comptes/{compte_id}", dependencies=[Depends(require_central)])
def central_update_account(compte_id: int, payload: CentralCompteUpdate, request: Request):
    acc = plateforme.get_compte(compte_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Compte inconnu")
    if payload.actif is False and current_user(request)["id"] == compte_id:
        raise HTTPException(status_code=409, detail="Vous ne pouvez pas désactiver votre propre compte")
    new = plateforme.update_compte(compte_id, nom=payload.nom, actif=payload.actif,
                                   mdp=auth.hash_password(payload.password) if payload.password else None)
    what = [x for x, v in (("nom", payload.nom), ("mot de passe", payload.password)) if v] + \
           (["activé" if payload.actif else "désactivé"] if payload.actif is not None else [])
    plateforme.log(_who(request), "admin.modification", new["nom"], ", ".join(what))
    return {k: v for k, v in new.items() if k != "mdp"}


# ---- Site vitrine : demandes de démonstration ------------------------------------------------

class DemandeIn(BaseModel):
    nom: str = Field(min_length=2, max_length=80)
    caserne: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=150, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    telephone: str = Field(default="", max_length=30)
    commune: str = Field(default="", max_length=120)
    equipiers: str = Field(default="", max_length=20)
    message: str = Field(default="", max_length=1500)
    site: str = Field(default="", max_length=200)  # piège à robots : champ caché, doit rester vide

    @field_validator("nom", "caserne", "email", "telephone", "commune", "equipiers")
    @classmethod
    def strip(cls, v: str) -> str:
        return " ".join(v.split())


_demandes_ip: dict[str, list[float]] = {}


@router.post("/api/vitrine/demande")
def vitrine_request(payload: DemandeIn, request: Request):
    """Demande de démonstration depuis almaneo.fr : enregistrée pour l'admin central."""
    ip = auth.client_ip(request)
    now = time.time()
    recent = [t for t in _demandes_ip.get(ip, []) if now - t < 3600]
    if len(recent) >= 5:
        raise HTTPException(status_code=429, detail="Trop de demandes : réessayez plus tard")
    _demandes_ip[ip] = recent + [now]
    if payload.site:  # rempli par un robot : on fait comme si tout allait bien
        return {"ok": True}
    plateforme.add_demande(payload.model_dump(exclude={"site"}))
    plateforme.log("site vitrine", "demande", payload.caserne, f"{payload.nom} · {payload.email}")
    return {"ok": True}


class DemandeUpdate(BaseModel):
    traitee: bool


@router.get("/api/plateforme/demandes", dependencies=[Depends(require_central)])
def central_requests():
    return {"demandes": plateforme.list_demandes()}


@router.put("/api/plateforme/demandes/{demande_id}", dependencies=[Depends(require_central)])
def central_request_done(demande_id: int, payload: DemandeUpdate):
    if not plateforme.set_demande_traitee(demande_id, payload.traitee):
        raise HTTPException(status_code=404, detail="Demande inconnue")
    return {"ok": True}
