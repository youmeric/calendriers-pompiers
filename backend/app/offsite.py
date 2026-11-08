"""Copie chiffrée de la sauvegarde hors du serveur : sur un partage WebDAV (NAS Synology, Nextcloud…)
ou dans un dossier monté (partage du NAS). Le fichier est chiffré avec une phrase secrète
(AES via Fernet, clé dérivée par PBKDF2) : illisible sans elle, même si le NAS est piraté."""
from __future__ import annotations

import base64
import os
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

MAGIC = b"CALPOMP1"  # en-tête du fichier chiffré : version + sel
ROUNDS = 390_000
NAME = re.compile(r"^calendriers-[0-9_-]+(-[a-z]+)?\.db\.chiffre$")
TIMEOUT = 120


def _key(passphrase: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ROUNDS)
    return base64.urlsafe_b64encode(kdf.derive(passphrase.encode()))


def encrypt(data: bytes, passphrase: str) -> bytes:
    salt = secrets.token_bytes(16)
    return MAGIC + salt + Fernet(_key(passphrase, salt)).encrypt(data)


def decrypt(blob: bytes, passphrase: str) -> bytes:
    if not blob.startswith(MAGIC):
        raise ValueError("ce fichier n'est pas une sauvegarde chiffrée du site")
    salt, token = blob[len(MAGIC):len(MAGIC) + 16], blob[len(MAGIC) + 16:]
    try:
        return Fernet(_key(passphrase, salt)).decrypt(token)
    except InvalidToken as err:
        raise ValueError("phrase secrète incorrecte ou fichier abîmé") from err


class OffsiteError(Exception):
    pass


def _request(method: str, url: str, user: str, password: str, data: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if user:
        token = base64.b64encode(f"{user}:{password}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # noqa: S310 (adresse réglée par l'admin)
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        if err.code in (401, 403):
            raise OffsiteError("identifiant ou mot de passe refusé par le serveur de sauvegarde") from err
        if method == "MKCOL" and err.code in (405, 409):
            return err.code, b""  # dossier déjà là
        raise OffsiteError(f"le serveur de sauvegarde a répondu {err.code} ({err.reason})") from err
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        raise OffsiteError(f"serveur de sauvegarde injoignable ({getattr(err, 'reason', err)})") from err


def push(cfg: dict, name: str, blob: bytes) -> None:
    """Envoie la copie chiffrée puis ne garde que les `garder` plus récentes."""
    keep = max(1, int(cfg.get("garder") or 30))
    if cfg["mode"] == "dossier":
        folder = cfg["dossier"]
        if not folder or not os.path.isdir(folder):
            raise OffsiteError(f"dossier introuvable sur le serveur : {folder or '(vide)'}")
        tmp = os.path.join(folder, name + ".part")
        with open(tmp, "wb") as fh:
            fh.write(blob)
        os.replace(tmp, os.path.join(folder, name))
        names = sorted(n for n in os.listdir(folder) if NAME.match(n))
        for old in names[:-keep]:
            os.remove(os.path.join(folder, old))
        return
    base = cfg["url"].rstrip("/") + "/"
    user, pwd = cfg.get("user", ""), cfg.get("password", "")
    _request("MKCOL", base, user, pwd)
    _request("PUT", base + urllib.parse.quote(name), user, pwd, blob, {"Content-Type": "application/octet-stream"})
    for old in sorted(list_remote(cfg))[:-keep]:
        _request("DELETE", base + urllib.parse.quote(old), user, pwd)


def list_remote(cfg: dict) -> list[str]:
    if cfg["mode"] == "dossier":
        return sorted(n for n in os.listdir(cfg["dossier"]) if NAME.match(n)) if os.path.isdir(cfg["dossier"] or "") else []
    base = cfg["url"].rstrip("/") + "/"
    _, body = _request("PROPFIND", base, cfg.get("user", ""), cfg.get("password", ""), b"", {"Depth": "1"})
    names = []
    try:
        for href in ET.fromstring(body).iter("{DAV:}href"):
            n = urllib.parse.unquote((href.text or "").rstrip("/").rsplit("/", 1)[-1])
            if NAME.match(n):
                names.append(n)
    except ET.ParseError as err:
        raise OffsiteError("réponse illisible du serveur de sauvegarde") from err
    return sorted(names)
