"""Authentification de la console : compte principal (ADMIN_PASSWORD) et comptes nominatifs avec
un rôle (trésorier, chef de tournée…) qui donne des droits ; cookie signé."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time

from fastapi import HTTPException, Request

from . import db

COOKIE_NAME = "admin_session"
SESSION_SECONDS = 7 * 24 * 3600
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"
PRINCIPAL_NAME = "Administrateur principal"

_secret: str | None = None


def _get_secret() -> bytes:
    global _secret
    if _secret is None:
        _secret = os.environ.get("SECRET_KEY") or db.get_or_create_secret()
    return _secret.encode()


def admin_password() -> str | None:
    return os.environ.get("ADMIN_PASSWORD") or None


def check_password(candidate: str) -> bool:
    expected = admin_password()
    if not expected:
        return False
    return hmac.compare_digest(candidate.encode(), expected.encode())


# ---- mots de passe des comptes (PBKDF2, sel aléatoire) ----

PBKDF2_ROUNDS = 200_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    return f"pbkdf2${PBKDF2_ROUNDS}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, rounds, salt, digest = stored.split("$")
        test = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt), int(rounds))
        return hmac.compare_digest(test, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


# ---- session : « compte.version.expiration.signature » (compte 0 = compte principal) ----

def _sign(account: int, version: int, expires: int) -> str:
    return hmac.new(_get_secret(), f"admin:{account}:{version}:{expires}".encode(), hashlib.sha256).hexdigest()


def _principal_version() -> int:
    # changer ADMIN_PASSWORD déconnecte les sessions du compte principal
    return int(hashlib.sha256((admin_password() or "").encode()).hexdigest()[:8], 16)


def make_token(account: dict | None = None) -> str:
    expires = int(time.time()) + SESSION_SECONDS
    aid, version = (account["id"], account["version"]) if account else (0, _principal_version())
    return f"{aid}.{version}.{expires}.{_sign(aid, version, expires)}"


def _principal() -> dict:
    return {"id": 0, "nom": PRINCIPAL_NAME, "identifiant": "", "role": "Administrateur", "principal": True,
            "permissions": list(db.PERMISSIONS)}


def console_user(request: Request) -> dict | None:
    """Compte de la console connecté (avec ses droits), ou None."""
    if hasattr(request.state, "console_user"):
        return request.state.console_user
    user = None
    token = request.cookies.get(COOKIE_NAME) or ""
    parts = token.split(".")
    if len(parts) == 4:
        try:
            aid, version, expires = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            aid = version = expires = -1
        if expires > time.time() and hmac.compare_digest(parts[3], _sign(aid, version, expires)):
            if aid == 0:
                user = _principal() if version == _principal_version() and admin_password() else None
            else:
                acc = db.get_compte(aid)
                if acc and acc["actif"] and acc["version"] == version:
                    user = {**acc, "principal": False}
    request.state.console_user = user
    return user


def has_perm(request: Request, *perms: str) -> bool:
    user = console_user(request)
    return bool(user) and any(p in user["permissions"] for p in perms)


def require_admin(request: Request) -> None:
    """N'importe quel compte de la console."""
    if not console_user(request):
        raise HTTPException(status_code=401, detail="Connexion admin requise")


def require(*perms: str):
    """Dépendance FastAPI : connecté, avec au moins un de ces droits."""
    def check(request: Request) -> None:
        require_admin(request)
        if not has_perm(request, *perms):
            raise HTTPException(status_code=403, detail="Votre rôle ne permet pas cette action")
    return check


# ---- Accès des équipes : code personnel -> cookie signé ---------------------------

TEAM_COOKIE = "equipe_session"
TEAM_SECONDS = 90 * 24 * 3600  # une saison de tournée

_attempts: dict[str, list[float]] = {}
MAX_ATTEMPTS = 10
ATTEMPT_WINDOW = 600  # 10 essais ratés par 10 minutes et par adresse IP


def _sign_team(personne_id: int, code: str, expires: int) -> str:
    return hmac.new(_get_secret(), f"equipe:{personne_id}:{code}:{expires}".encode(), hashlib.sha256).hexdigest()


def make_team_token(personne_id: int, code: str) -> str:
    expires = int(time.time()) + TEAM_SECONDS
    return f"{personne_id}.{expires}.{_sign_team(personne_id, code, expires)}"


def team_member(request: Request) -> dict | None:
    """Personne connectée avec son code (None sinon). Régénérer le code coupe l'accès."""
    token = request.cookies.get(TEAM_COOKIE)
    if not token or token.count(".") != 2:
        return None
    pid_s, expires_s, signature = token.split(".")
    try:
        pid, expires = int(pid_s), int(expires_s)
    except ValueError:
        return None
    if expires < time.time():
        return None
    person = db.get_personne(pid)
    if not person or not person.get("code"):
        return None
    if not hmac.compare_digest(signature, _sign_team(pid, person["code"], expires)):
        return None
    return person


def is_admin(request: Request) -> bool:
    """Accès « administrateur » de l'espace équipe (tous les secteurs) : suivi ou dons."""
    return has_perm(request, "suivi", "dons")


def too_many_attempts(ip: str) -> bool:
    now = time.time()
    recent = [t for t in _attempts.get(ip, []) if now - t < ATTEMPT_WINDOW]
    _attempts[ip] = recent
    return len(recent) >= MAX_ATTEMPTS


def record_failure(ip: str) -> None:
    _attempts.setdefault(ip, []).append(time.time())
