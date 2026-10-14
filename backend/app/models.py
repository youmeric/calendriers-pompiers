from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class StatusUpdate(BaseModel):
    status: Literal["fait", "absent", "refus", None] = None
    note: str | None = Field(default=None, max_length=500)


class LoginIn(BaseModel):
    password: str = Field(max_length=200)


class SectorIn(BaseModel):
    id: int | None = None
    nom: str = Field(min_length=1, max_length=80)
    couleur: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    polygon: list[tuple[float, float]] = Field(min_length=3, max_length=5000)

    @field_validator("nom")
    @classmethod
    def strip_nom(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("le nom du secteur est obligatoire")
        return v

    @field_validator("polygon")
    @classmethod
    def check_coords(cls, v: list[tuple[float, float]]) -> list[tuple[float, float]]:
        for lat, lon in v:
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("coordonnées hors limites")
        return v


class SectorsIn(BaseModel):
    sectors: list[SectorIn] = Field(max_length=50)
