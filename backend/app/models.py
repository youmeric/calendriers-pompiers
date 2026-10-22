from __future__ import annotations

import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

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
    # champs facultatifs : on n'enregistre que ce qui est envoyé
    suivi_adresses: bool | None = None
    annee: int | None = Field(default=None, ge=2000, le=2100)
    equipes_public: bool | None = None
    telephones_public: bool | None = None
    dons_actifs: bool | None = None
    sumup_actif: bool | None = None
    sumup_affiliate_key: str | None = Field(default=None, max_length=200)
    sumup_app_id: str | None = Field(default=None, max_length=200)
    # bot WhatsApp (wppconnect) : adresse de son « POST /send », clé facultative, modèle du message d'accès
    whatsapp_bot_url: str | None = Field(default=None, max_length=300)
    whatsapp_bot_key: str | None = Field(default=None, max_length=200)
    whatsapp_message: str | None = Field(default=None, max_length=1500)

    @field_validator("whatsapp_bot_url")
    @classmethod
    def check_bot_url(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip().rstrip("/")
        if v and not re.fullmatch(r"https?://[A-Za-z0-9.\-_:\[\]]+(/[A-Za-z0-9._~\-/]*)?", v):
            raise ValueError("adresse du bot invalide (ex. http://192.168.1.20:3000)")
        return v

    @field_validator("whatsapp_bot_key")
    @classmethod
    def check_bot_key(cls, v: str | None) -> str | None:
        return v.strip() if v is not None else v

    @field_validator("sumup_affiliate_key", "sumup_app_id")
    @classmethod
    def clean_key(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if v and not re.fullmatch(r"[A-Za-z0-9._\-]+", v):
            raise ValueError("caractères non autorisés")
        return v


# ---- Équipes -----------------------------------------------------------------

class PersonneIn(BaseModel):
    nom: str = Field(min_length=1, max_length=80)
    telephone: str = Field(default="", max_length=30)

    @field_validator("nom")
    @classmethod
    def strip_nom(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("le nom est obligatoire")
        return v

    @field_validator("telephone")
    @classmethod
    def check_tel(cls, v: str) -> str:
        v = v.strip()
        if v and not re.fullmatch(r"[0-9+ .()\-]{4,30}", v):
            raise ValueError("numéro de téléphone invalide")
        return v


class PersonnesIn(BaseModel):
    personnes: list[PersonneIn] = Field(min_length=1, max_length=200)


class MembreIn(BaseModel):
    personne_id: int
    role: Literal["responsable", "equipier"]


class EquipeIn(BaseModel):
    date: str = ""
    creneau: str = Field(default="", max_length=40)
    statut: Literal["a_faire", "en_cours", "termine"] = "a_faire"
    note: str = Field(default="", max_length=500)
    membres: list[MembreIn] = Field(default_factory=list, max_length=40)

    @field_validator("date")
    @classmethod
    def check_date(cls, v: str) -> str:
        v = v.strip()
        if v:
            try:
                date.fromisoformat(v)
            except ValueError:
                raise ValueError("date invalide (AAAA-MM-JJ)") from None
        return v

    @field_validator("creneau", "note")
    @classmethod
    def strip_text(cls, v: str) -> str:
        return v.strip()

    @field_validator("membres")
    @classmethod
    def unique_membres(cls, v: list[MembreIn]) -> list[MembreIn]:
        ids = [m.personne_id for m in v]
        if len(ids) != len(set(ids)):
            raise ValueError("une même personne apparaît deux fois dans l'équipe")
        return v


class SectorsIn(BaseModel):
    sectors: list[SectorIn] = Field(max_length=50)


# ---- Accès des équipes et dons ----------------------------------------------------

class CodeIn(BaseModel):
    code: str = Field(min_length=1, max_length=40)


class DonIn(BaseModel):
    slug: str = Field(max_length=80)
    address_id: str = Field(max_length=120)
    montant: float = Field(gt=0, le=1000)
    mode: Literal["especes", "cheque", "cb"]
    note: str = Field(default="", max_length=200)
    tx_code: str = Field(default="", max_length=64)
    sumup: bool = False  # paiement CB lancé dans l'appli SumUp (en attente de son retour)
    # identifiant donné par le téléphone : un don saisi hors réseau et renvoyé deux fois n'est compté qu'une fois
    client_id: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")

    @field_validator("note", "tx_code")
    @classmethod
    def strip_text(cls, v: str) -> str:
        return v.strip()


class DonStatutIn(BaseModel):
    statut: Literal["ok", "echec"]
    tx_code: str = Field(default="", max_length=64)


class SumupRetourIn(BaseModel):
    foreign_id: str = Field(min_length=8, max_length=128)
    status: str = Field(default="", max_length=30)
    tx_code: str = Field(default="", max_length=64)


class RemiseIn(BaseModel):
    especes: float = Field(ge=0, le=100000)
    cheques: float = Field(ge=0, le=100000)
    nb_cheques: int = Field(default=0, ge=0, le=2000)
    recu_par: str = Field(min_length=1, max_length=80)
    note: str = Field(default="", max_length=300)

    @field_validator("note")
    @classmethod
    def strip_note(cls, v: str) -> str:
        return " ".join(v.split())

    @field_validator("recu_par")
    @classmethod
    def strip_recu(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("indiquez à qui la caisse est remise")
        return v


class ConfirmIn(BaseModel):
    confirme: bool


class AvancementIn(BaseModel):
    statut: Literal["a_faire", "en_cours", "termine"]


class RenfortIn(BaseModel):
    """Équipier ajouté par le responsable : une personne de la liste, ou une nouvelle."""
    personne_id: int | None = None
    personne: PersonneIn | None = None

    @model_validator(mode="after")
    def one_of(self):
        if (self.personne_id is None) == (self.personne is None):
            raise ValueError("choisir une personne ou en saisir une nouvelle")
        return self


class NoteIn(BaseModel):
    slug: str = Field(max_length=80)
    address_id: str = Field(max_length=120)
    note: str = Field(default="", max_length=300)

    @field_validator("note")
    @classmethod
    def strip_note(cls, v: str) -> str:
        return " ".join(v.split())


class SignalementIn(BaseModel):
    """Problème d'adresse vu sur le terrain : maison manquante (position), maison vide, erreur…"""
    slug: str = Field(max_length=80)
    type: Literal["manquante", "vide", "erreur", "autre"]
    address_id: str | None = Field(default=None, max_length=120)
    sector_id: int | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    numero: str = Field(default="", max_length=12)
    nom_voie: str = Field(default="", max_length=120)
    note: str = Field(default="", max_length=300)

    @field_validator("numero", "nom_voie", "note")
    @classmethod
    def strip_text(cls, v: str) -> str:
        return " ".join(v.split())

    @model_validator(mode="after")
    def check_target(self):
        if self.type == "manquante":
            if self.lat is None or self.lon is None or self.sector_id is None:
                raise ValueError("placer la maison manquante sur la carte")
        elif not self.address_id:
            raise ValueError("choisir la maison concernée")
        return self


class SignalementActionIn(BaseModel):
    action: Literal["ajouter", "exclure", "traite", "ignore", "rouvrir"]
    numero: str = Field(default="", max_length=12)
    nom_voie: str = Field(default="", max_length=120)

    @field_validator("numero", "nom_voie")
    @classmethod
    def strip_text(cls, v: str) -> str:
        return " ".join(v.split())


class EnvoiAccesIn(BaseModel):
    personne_id: int
    # adresse du site telle que l'admin la voit (pour le lien personnel du message)
    origin: str = Field(max_length=200, pattern=r"^https?://[A-Za-z0-9.\-:\[\]]+$")
    modele: str | None = Field(default=None, max_length=1500)  # aperçu d'un modèle pas encore enregistré
