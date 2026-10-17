"""Authentification admin : mot de passe unique (ADMIN_PASSWORD) + cookie signé."""
from __future__ import annotations

import hashlib
import hmac
import os
import time

from fastapi import HTTPException, Request

from . import db

COOKIE_NAME = "admin_session"
SESSION_SECONDS = 7 * 24 * 3600
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"

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


def _sign(expires: int) -> str:
    return hmac.new(_get_secret(), f"admin:{expires}".encode(), hashlib.sha256).hexdigest()


def make_token() -> str:
    expires = int(time.time()) + SESSION_SECONDS
    return f"{expires}.{_sign(expires)}"


def is_valid_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    expires_s, signature = token.split(".", 1)
    try:
        expires = int(expires_s)
    except ValueError:
        return False
    if expires < time.time():
        return False
    return hmac.compare_digest(signature, _sign(expires))


def require_admin(request: Request) -> None:
    if not is_valid_token(request.cookies.get(COOKIE_NAME)):
        raise HTTPException(status_code=401, detail="Connexion admin requise")


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
    return is_valid_token(request.cookies.get(COOKIE_NAME))


def too_many_attempts(ip: str) -> bool:
    now = time.time()
    recent = [t for t in _attempts.get(ip, []) if now - t < ATTEMPT_WINDOW]
    _attempts[ip] = recent
    return len(recent) >= MAX_ATTEMPTS


def record_failure(ip: str) -> None:
    _attempts.setdefault(ip, []).append(time.time())
