"""Résumé lisible d'un secteur : hameaux, rues et numéros qu'il contient."""
from __future__ import annotations

import re
from collections import Counter

MIN_HAMEAU = 3  # en dessous, les maisons sont listées dans « Habitations isolées »
ISOLATED = "Habitations isolées"


def _num(numero: str) -> int | None:
    m = re.match(r"\d+", numero or "")
    return int(m.group()) if m else None


def voie_name(addr: dict) -> str:
    return addr.get("nom_voie") or addr.get("lieu_dit") or "Sans nom de voie"


def commune_voie_counts(addresses: list[dict]) -> Counter:
    return Counter(voie_name(a) for a in addresses)


def build_resume(sector_addresses: list[dict], commune_counts: Counter) -> list[dict]:
    """[{"nom": hameau, "nb": n, "voies": [{"nom", "nb", "min", "max", "cote", "partiel"}]}]"""
    sector_counts = Counter(voie_name(a) for a in sector_addresses)

    by_group: dict[str, list[dict]] = {}
    for a in sector_addresses:
        by_group.setdefault(a["groupe"], []).append(a)

    entries: dict[str, list[dict]] = {}
    for name, addrs in by_group.items():
        key = name if len(addrs) >= MIN_HAMEAU else ISOLATED
        entries.setdefault(key, []).extend(addrs)

    resume = []
    for name, addrs in entries.items():
        voies: dict[str, list[dict]] = {}
        for a in addrs:
            voies.setdefault(voie_name(a), []).append(a)
        voie_list = []
        for vname, vaddrs in voies.items():
            nums = sorted(n for n in (_num(a.get("numero", "")) for a in vaddrs) if n is not None)
            partiel = sector_counts[vname] < commune_counts[vname]
            cote = None
            if partiel and nums:
                if all(n % 2 == 0 for n in nums):
                    cote = "pair"
                elif all(n % 2 == 1 for n in nums):
                    cote = "impair"
            voie_list.append({
                "nom": vname,
                "nb": len(vaddrs),
                "min": nums[0] if nums else None,
                "max": nums[-1] if nums else None,
                "cote": cote,
                "partiel": partiel,
            })
        voie_list.sort(key=lambda v: (-v["nb"], v["nom"]))
        resume.append({"nom": name, "nb": len(addrs), "voies": voie_list})

    resume.sort(key=lambda e: (e["nom"] == ISOLATED, e["nom"] != "Le bourg", -e["nb"]))
    return resume
