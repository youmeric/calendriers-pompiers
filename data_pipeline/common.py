"""Fonctions partagées par le pipeline de données (géométrie, HTTP, cache)."""
from __future__ import annotations

import gzip
import json
import math
import os
import time
from pathlib import Path
from typing import Iterable

import requests

CACHE_DIR = Path(os.environ.get("BAN_CACHE_DIR") or (Path(__file__).resolve().parent.parent / "data" / "cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)

USER_AGENT = "calendriers-pompiers-courzieu-brussieu/1.0 (contact: mairie locale)"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})


def http_get(url: str, params: dict | None = None, timeout: int = 60, retries: int = 3):
    last_err = None
    for attempt in range(retries):
        try:
            resp = SESSION.get(url, params=params, timeout=timeout)
            resp.raise_for_status()
            return resp
        except requests.RequestException as exc:  # pragma: no cover - réseau
            last_err = exc
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Échec GET {url}: {last_err}")


def http_post(url: str, data: str, timeout: int = 180, retries: int = 3):
    last_err = None
    for attempt in range(retries):
        try:
            resp = SESSION.post(url, data=data.encode("utf-8"), timeout=timeout)
            resp.raise_for_status()
            return resp
        except requests.RequestException as exc:  # pragma: no cover - réseau
            last_err = exc
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Échec POST {url}: {last_err}")


def cache_path(name: str) -> Path:
    return CACHE_DIR / name


def read_cache(name: str):
    path = cache_path(name)
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_cache(name: str, data) -> None:
    path = cache_path(name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance orthodromique (mètres) entre deux points WGS84."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Cap (0-360°) du point 2 vu depuis le point 1, utilisé pour trier en balayage angulaire."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlmb = math.radians(lon2 - lon1)
    y = math.sin(dlmb) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlmb)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def slugify(value: str) -> str:
    import unicodedata

    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    value = "".join(c if c.isalnum() else "-" for c in value.lower())
    while "--" in value:
        value = value.replace("--", "-")
    return value.strip("-")
