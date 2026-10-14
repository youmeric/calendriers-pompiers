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
