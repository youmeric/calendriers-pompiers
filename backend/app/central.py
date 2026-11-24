"""Admin central de la plateforme multi-casernes : créer et gérer les casernes.

Joignable à l'adresse de l'admin central (admin.<domaine>, ou toute adresse qui ne mène à aucune
caserne), sous /plateforme. Compte : PLATFORM_ADMIN_PASSWORD (variable d'environnement)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
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


def _version() -> str:
    return hashlib.sha256((_password() or "").encode()).hexdigest()[:10]


def _sign(expires: int) -> str:
    return hmac.new(_secret(), f"central:{_version()}:{expires}".encode(), hashlib.sha256).hexdigest()


def require_central(request: Request) -> None:
    token = request.cookies.get(COOKIE) or ""
    parts = token.split(".")
    if len(parts) == 2 and parts[0].isdigit() and int(parts[0]) > time.time() and _password() \
            and hmac.compare_digest(parts[1], _sign(int(parts[0]))):
        return
    raise HTTPException(status_code=401, detail="Connexion à l'admin central requise")


class LoginIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)


@router.post("/api/plateforme/login")
def login(payload: LoginIn, request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    if auth.too_many_attempts(ip):
        raise HTTPException(status_code=429, detail="Trop d'essais : réessayez dans quelques minutes")
    if not _password():
        raise HTTPException(status_code=503, detail="PLATFORM_ADMIN_PASSWORD n'est pas configuré sur le serveur")
    if not hmac.compare_digest(payload.password.encode(), _password().encode()):
        auth.record_failure(ip)
        plateforme.log("?", "connexion.echec", "", f"adresse {ip}")
        time.sleep(1)
        raise HTTPException(status_code=401, detail="Mot de passe incorrect")
    expires = int(time.time()) + SESSION_SECONDS
    response.set_cookie(COOKIE, f"{expires}.{_sign(expires)}", max_age=SESSION_SECONDS, httponly=True,
                        samesite="strict", secure=auth.COOKIE_SECURE)
    plateforme.log("admin central", "connexion")
    return {"ok": True}


@router.post("/api/plateforme/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/api/plateforme/moi", dependencies=[Depends(require_central)])
def me():
    return {"ok": True, "domaine": plateforme.PLATFORM_DOMAIN, "abonnements_actifs": plateforme.abonnements_actifs()}


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
        communes = []
        index = Path(cas.data_dir) / "index.json"
        if index.exists():
            communes = [c["nom"] for c in json.loads(index.read_text(encoding="utf-8")).get("communes", [])]
    return {**stats, "communes": communes, "taille_base": size}


def _view(cas: plateforme.Caserne) -> dict:
    return {"id": cas.id, "slug": cas.slug, "nom": cas.nom, "statut": cas.statut, "hosts": plateforme.hosts(cas.id),
            "url": _url(cas), "abonnement": plateforme.abonnement_etat(cas),
            "abonnement_formule": cas.abonnement, "abonnement_fin": cas.abonnement_fin,
            "generation": plateforme.last_generation(cas.id), "stats": _stats(cas)}


@router.get("/api/plateforme/casernes", dependencies=[Depends(require_central)])
def list_casernes():
    return {"casernes": [_view(c) for c in plateforme.list_casernes()], "abonnements_actifs": plateforme.abonnements_actifs()}


@router.post("/api/plateforme/casernes", dependencies=[Depends(require_central)])
def create_caserne(payload: CaserneIn):
    if plateforme.get_by_slug(payload.slug):
        raise HTTPException(status_code=409, detail="Une caserne a déjà cet identifiant")
    hosts = _check_hosts(payload.hosts, None)
    cas = plateforme.create(payload.slug, payload.nom.strip(), hosts)
    with plateforme.use(cas):
        db.init_db()
        db.set_setting("asso_nom", payload.nom.strip())
        role = next(r for r in db.list_roles() if r["fixe"])  # « Administrateur » : tous les droits
        db.add_compte(payload.admin_identifiant.strip(), payload.admin_nom.strip(), auth.hash_password(payload.admin_password), role["id"])
        db.log("Admin central", "console", "caserne.creation", payload.nom, f"compte administrateur « {payload.admin_identifiant} »")
    plateforme.log("admin central", "caserne.creation", payload.nom, f"{payload.slug} · {', '.join(hosts) or 'pas d’adresse'}")
    if payload.communes:
        _start_generation(cas, [c.model_dump() for c in payload.communes])
    return _view(plateforme.get(cas.id))


def _get(caserne_id: int) -> plateforme.Caserne:
    cas = plateforme.get(caserne_id)
    if not cas:
        raise HTTPException(status_code=404, detail="Caserne inconnue")
    return cas


@router.put("/api/plateforme/casernes/{caserne_id}", dependencies=[Depends(require_central)])
def update_caserne(caserne_id: int, payload: CaserneUpdate):
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
    new = plateforme.update(caserne_id, **fields)
    plateforme.log("admin central", "caserne.modification", new.nom,
                   " · ".join(f"{k} : {v}" for k, v in payload.model_dump(exclude_none=True).items()))
    return _view(new)


@router.post("/api/plateforme/casernes/{caserne_id}/comptes", dependencies=[Depends(require_central)])
def add_admin_account(caserne_id: int, payload: CompteIn):
    """Nouveau compte administrateur dans une caserne (ex. mot de passe perdu par son responsable)."""
    cas = _get(caserne_id)
    with plateforme.use(cas):
        if db.compte_login(payload.identifiant):
            raise HTTPException(status_code=409, detail="Cet identifiant existe déjà dans cette caserne")
        role = next(r for r in db.list_roles() if r["fixe"])
        acc = db.add_compte(payload.identifiant.strip(), payload.nom.strip(), auth.hash_password(payload.password), role["id"])
        db.log("Admin central", "console", "compte.ajout", acc["nom"], f"identifiant {acc['identifiant']} · rôle Administrateur")
    plateforme.log("admin central", "compte.ajout", cas.nom, payload.identifiant)
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


@router.put("/api/plateforme/reglages", dependencies=[Depends(require_central)])
def save_settings(payload: ReglagesIn):
    if payload.abonnements_actifs is not None:
        plateforme.set_reglage("abonnements_actifs", "1" if payload.abonnements_actifs else "0")
        plateforme.log("admin central", "reglages", "abonnements", "activés" if payload.abonnements_actifs else "désactivés")
    return {"abonnements_actifs": plateforme.abonnements_actifs()}


@router.get("/api/plateforme/journal", dependencies=[Depends(require_central)])
def central_journal():
    return {"entrees": plateforme.journal()}
