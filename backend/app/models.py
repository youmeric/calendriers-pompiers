from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from .geo import normalize_polys


class StatusUpdate(BaseModel):
    status: Literal["fait", "absent", "refus", None] = None
    note: str | None = Field(default=None, max_length=500)


class LoginIn(BaseModel):
    password: str = Field(max_length=200)


MAX_POINTS = 30000


class SectorIn(BaseModel):
    id: int | None = None
    nom: str = Field(min_length=1, max_length=120)
    couleur: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    # morceaux avec enclaves (voir geo.normalize_polys) ; un contour seul est aussi accepté
    polygon: list

    @field_validator("nom")
    @classmethod
    def strip_nom(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("le nom du secteur est obligatoire")
        return v

    @field_validator("polygon")
    @classmethod
    def check_polys(cls, v: list) -> list:
        if not v:
            raise ValueError("le secteur n'a pas de contour")
        polys = normalize_polys(v)
        try:
            clean = []
            for poly in polys:
                rings = [[[float(lat), float(lon)] for lat, lon in ring] for ring in poly]
                rings = [r for r in rings if len(r) >= 3]
                if rings:
                    clean.append(rings)
        except (TypeError, ValueError):
            raise ValueError("contour illisible") from None
        if not clean:
            raise ValueError("le contour doit avoir au moins 3 points")
        if sum(len(r) for poly in clean for r in poly) > MAX_POINTS:
            raise ValueError("contour trop détaillé")
        for poly in clean:
            for ring in poly:
                for lat, lon in ring:
                    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                        raise ValueError("coordonnées hors limites")
        return clean


class ExclusionIn(BaseModel):
    address_ids: list[str] = Field(min_length=1, max_length=2000)
    excluded: bool


class SettingsIn(BaseModel):
    suivi_adresses: bool


class SectorsIn(BaseModel):
    sectors: list[SectorIn] = Field(max_length=50)
