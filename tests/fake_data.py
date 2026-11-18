"""Commune de test synthétique (144 maisons en grille, 4 secteurs proposés), pour ne pas dépendre
de la Base Adresse ni d'OpenStreetMap. Usage : python fake_data.py <dossier>"""
import json, os, sys
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
lat0, lon0 = 45.742, 4.570
addrs = []
voies = ["Rue de la Mairie", "Route des Granges", "Chemin du Bois", "Impasse du Lavoir"]
for i in range(12):
    for j in range(12):
        v = voies[(i // 6) * 2 + j // 6]
        addrs.append({"id": f"69067_{i:02d}{j:02d}", "numero": str(j + 1), "rep": "", "nom_voie": v,
                      "label": f"{i * 12 + j + 1} {v}", "lieu_dit": "", "groupe": v, "groupe_id": (i // 6) * 2 + j // 6,
                      "lat": lat0 + i * 0.001, "lon": lon0 + j * 0.0014})
def box(la1, lo1, la2, lo2):
    return [[la1, lo1], [la1, lo2], [la2, lo2], [la2, lo1]]
mid_la, mid_lo = lat0 + 0.0055, lon0 + 0.0077
e = 0.002
autos = [
    {"nom": "Sud-Ouest", "couleur": "#e6194b", "polygon": box(lat0 - e, lon0 - e, mid_la, mid_lo), "nb_adresses": 36},
    {"nom": "Sud-Est", "couleur": "#3cb44b", "polygon": box(lat0 - e, mid_lo, mid_la, lon0 + 0.017 + e), "nb_adresses": 36},
    {"nom": "Nord-Ouest", "couleur": "#4363d8", "polygon": box(mid_la, lon0 - e, lat0 + 0.012 + e, mid_lo), "nb_adresses": 36},
    {"nom": "Nord-Est", "couleur": "#f58231", "polygon": box(mid_la, mid_lo, lat0 + 0.012 + e, lon0 + 0.017 + e), "nb_adresses": 36},
]
commune = {"nom": "Courzieu", "slug": "courzieu", "code": "69067",
           "mairie": {"lat": lat0 + 0.005, "lon": lon0 + 0.007},
           "contour": {"type": "Polygon", "coordinates": [[[lo, la] for la, lo in box(lat0 - 0.004, lon0 - 0.004, lat0 + 0.016, lon0 + 0.021)] + [[lon0 - 0.004, lat0 - 0.004]]]}}
json.dump({"commune": commune, "addresses": addrs, "auto_sectors": autos, "roads": [], "buildings": []},
          open(f"{out}/courzieu.json", "w"), ensure_ascii=False)
json.dump({"communes": [{"slug": "courzieu", "nom": "Courzieu", "code": "69067", "nb_adresses": len(addrs)}]},
          open(f"{out}/index.json", "w"), ensure_ascii=False)
