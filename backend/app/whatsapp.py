"""Envoi direct par le bot WhatsApp (wppconnect) : on appelle son « POST /send » comme le
ferait la dernière étape de n8n, sans passer par le site de programmation ni par n8n."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

DEFAULT_MESSAGE = (
    "Bonjour {prenom} 👋\n\n"
    "Voici ton accès personnel à l'espace équipe de la *{tournee}* des pompiers de Courzieu{secteurs} :\n"
    "{lien}\n\n"
    "Ou bien saisis le code *{code}* dans « Espace équipe ».\n"
    "Il est personnel : ne le transfère pas."
)

TIMEOUT = 25  # secondes : l'envoi d'un message par le bot prend en général 1 à 3 s


def whatsapp_id(telephone: str) -> str | None:
    """« 06 12 34 56 78 » -> « 33612345678@c.us » (format attendu par wppconnect)."""
    d = re.sub(r"[^0-9+]", "", telephone or "")
    if d.startswith("+"):
        d = d[1:]
    elif d.startswith("00"):
        d = d[2:]
    elif d.startswith("0") and len(d) == 10:
        d = "33" + d[1:]
    d = re.sub(r"\D", "", d)
    return f"{d}@c.us" if 8 <= len(d) <= 15 else None


def render(template: str, values: dict[str, str]) -> str:
    """Remplace {prenom}, {nom}, {code}, {lien}, {secteurs}, {tournee}, {annee} ; le reste est laissé tel quel."""
    return re.sub(r"\{(\w+)\}", lambda m: values.get(m.group(1), m.group(0)), template)


class BotError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _call(url: str, key: str, payload: dict | None = None) -> dict:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-API-Key"] = key
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # noqa: S310 (adresse réglée par l'admin)
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        try:
            detail = json.loads(err.read().decode("utf-8", "replace")).get("error") or err.reason
        except Exception:  # noqa: BLE001
            detail = err.reason
        if err.code == 503:
            raise BotError("Le bot WhatsApp n'est pas prêt (session déconnectée ? QR à rescanner)", 503) from err
        raise BotError(f"Le bot a refusé l'envoi : {detail}") from err
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        reason = getattr(err, "reason", err)
        raise BotError(f"Bot WhatsApp injoignable ({reason})", 504) from err
    try:
        return json.loads(body) if body else {}
    except ValueError:
        return {}


def health(base_url: str, key: str) -> dict:
    return _call(f"{base_url}/health", key)


def send(base_url: str, key: str, to: str, message: str) -> None:
    res = _call(f"{base_url}/send", key, {"to": to, "message": message})
    if res.get("ok") is False:
        raise BotError(f"Le bot a refusé l'envoi : {res.get('error') or 'erreur inconnue'}")
