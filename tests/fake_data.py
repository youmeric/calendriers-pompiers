"""Communes de test synthétiques, pour ne pas dépendre de la Base Adresse ni d'OpenStreetMap :
Courzieu (144 maisons en grille, 4 secteurs proposés) et Brussieu (36 maisons, 2 secteurs proposés),
un peu plus au sud. Usage : python fake_data.py <dossier>"""
import json, os, sys
out = sys.argv[1]
os.makedirs(out, exist_ok=True)


def box(la1, lo1, la2, lo2):
    return [[la1, lo1], [la1, lo2], [la2, lo2], [la2, lo1]]


def commune(slug, nom, code, lat0, lon0, n, voies, couleurs):
    addrs = []
    half = n // 2
    for i in range(n):
        for j in range(n):
            v = voies[(i // half) * 2 + j // half]
            addrs.append({"id": f"{code}_{i:02d}{j:02d}", "numero": str(j + 1), "rep": "", "nom_voie": v,
                          "label": f"{i * n + j + 1} {v}", "lieu_dit": "", "groupe": v, "groupe_id": (i // half) * 2 + j // half,
                          "lat": lat0 + i * 0.001, "lon": lon0 + j * 0.0014})
    e = 0.002
    top, right = lat0 + (n - 1) * 0.001 + e, lon0 + (n - 1) * 0.0014 + e
    mid_la, mid_lo = lat0 + (half - 0.5) * 0.001, lon0 + (half - 0.5) * 0.0014
    per = (n * n) // len(couleurs)
    if len(couleurs) == 4:
        boxes = [box(lat0 - e, lon0 - e, mid_la, mid_lo), box(lat0 - e, mid_lo, mid_la, right),
                 box(mid_la, lon0 - e, top, mid_lo), box(mid_la, mid_lo, top, right)]
        noms = ["Sud-Ouest", "Sud-Est", "Nord-Ouest", "Nord-Est"]
    else:
        boxes = [box(lat0 - e, lon0 - e, top, mid_lo), box(lat0 - e, mid_lo, top, right)]
        noms = ["Ouest", "Est"]
    autos = [{"nom": nm, "couleur": c, "polygon": b, "nb_adresses": per} for nm, c, b in zip(noms, couleurs, boxes)]
    data = {"commune": {"nom": nom, "slug": slug, "code": code, "mairie": {"lat": lat0 + n * 0.0004, "lon": lon0 + n * 0.0006},
                        "contour": {"type": "Polygon", "coordinates": [[[lo, la] for la, lo in box(lat0 - 0.004, lon0 - 0.004, top + 0.002, right + 0.002)]
                                                                       + [[lon0 - 0.004, lat0 - 0.004]]]}},
            "addresses": addrs, "auto_sectors": autos, "roads": [], "buildings": []}
    with open(f"{out}/{slug}.json", "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    return {"slug": slug, "nom": nom, "code": code, "nb_adresses": len(addrs)}


communes = [
    commune("courzieu", "Courzieu", "69067", 45.742, 4.570, 12,
            ["Rue de la Mairie", "Route des Granges", "Chemin du Bois", "Impasse du Lavoir"],
            ["#e6194b", "#3cb44b", "#4363d8", "#f58231"]),
    commune("brussieu", "Brussieu", "69031", 45.715, 4.540, 6,
            ["Route de Lyon", "Rue du Stade", "Chemin des Vignes", "Place de l'Église"], ["#911eb4", "#42d4f4"]),
]
with open(f"{out}/index.json", "w", encoding="utf-8") as fh:
    json.dump({"communes": communes}, fh, ensure_ascii=False)
