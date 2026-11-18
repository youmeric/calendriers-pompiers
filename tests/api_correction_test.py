import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _env  # noqa: E402,F401  (base de test temporaire + données de test, voir _env.py)
from fastapi.testclient import TestClient
from backend.app.main import app

fails = 0
def check(c, m):
    global fails
    print(("OK  " if c else "FAIL") + " " + m)
    fails += 0 if c else 1

admin = TestClient(app)
with admin:
    admin.post("/api/admin/login", json={"password": "secret123"})
    autos = admin.get("/api/admin/communes/courzieu").json()["auto_sectors"]
    secs = admin.put("/api/admin/communes/courzieu/sectors", json={"sectors": autos}).json()["sectors"]
    s1, s2 = secs[0]["id"], secs[1]["id"]
    jean, = admin.post("/api/admin/personnes", json={"personnes": [{"nom": "Jean"}]}).json()["personnes"]
    admin.put(f"/api/admin/secteurs/{s1}/equipe", json={"membres": [{"personne_id": jean["id"], "role": "responsable"}]})
    admin.put("/api/admin/settings", json={"suivi_adresses": True, "dons_actifs": True})
    pub = lambda: {s["id"]: s["addresses"] for s in admin.get("/api/communes/courzieu").json()["sectors"]}  # noqa: E731
    a = pub()[s1][0]
    j = TestClient(app); j.post("/api/equipe/login", json={"code": jean["code"]})
    j.post(f"/api/communes/courzieu/addresses/{a['id']}/status", json={"status": "fait"})
    j.post("/api/equipe/notes", json={"slug": "courzieu", "address_id": a["id"], "note": "chien"})
    j.post("/api/equipe/dons", json={"slug": "courzieu", "address_id": a["id"], "montant": 10, "mode": "especes"})
    sig = j.post("/api/equipe/signalements", json={"slug": "courzieu", "type": "erreur", "address_id": a["id"], "note": "c'est le 14"}).json()
    rows = admin.get("/api/admin/signalements").json()["signalements"]
    x = next(r for r in rows if r["id"] == sig["id"])
    check(x["numero_actuel"] == a["numero"] and x["voie_actuelle"] == a["nom_voie"], "signalement : numéro et rue actuels pour pré-remplir")
    # correction depuis le signalement
    r = admin.post(f"/api/admin/signalements/{sig['id']}", json={"action": "corriger", "numero": "14", "nom_voie": "Rue des Écoles"})
    check(r.status_code == 200 and r.json()["statut"] == "traite", "signalement : « Corriger l'adresse » → traité")
    b = next(y for y in pub()[s1] if y["id"] == a["id"])
    check(b["label"] == "14 Rue des Écoles" and b["numero"] == "14" and b["nom_voie"] == "Rue des Écoles", "site / équipes : nouvelle adresse")
    t = j.get(f"/api/equipe/secteurs/{s1}/suivi").json()
    check(t["statuses"][a["id"]]["status"] == "fait" and t["notes"][a["id"]]["note"] == "chien" and any(d["address_id"] == a["id"] for d in t["dons"]), "historique gardé (statut, note, don)")
    reg = admin.get("/api/admin/fiscal").json()["registre"]
    check(any("14 Rue des Écoles" in r["adresse"] for r in reg), "registre des dons : adresse corrigée")
    adm = next(y for y in admin.get("/api/admin/communes/courzieu").json()["addresses"] if y["id"] == a["id"])
    check(adm["corrigee"] and adm["origine"]["label"] == a["label"], "admin : adresse d'origine gardée")
    jr = admin.get("/api/admin/journal").json()["entrees"]
    check(any(e["action"] == "adresse.corrigee" and f"{a['label']} → 14 Rue des Écoles" in e["details"] for e in jr), "journal : avant → après")
    # déplacer le point dans le secteur voisin : la maison change de secteur, son historique suit
    target = pub()[s2][0]
    u = f"/api/admin/communes/courzieu/addresses/{a['id']}/correction"
    r = admin.put(u, json={"numero": "14", "nom_voie": "Rue des Écoles", "lat": target["lat"] + 0.0001, "lon": target["lon"]})
    check(r.status_code == 200 and r.json()["lat"] == target["lat"] + 0.0001, "point déplacé")
    check(any(y["id"] == a["id"] for y in pub()[s2]) and not any(y["id"] == a["id"] for y in pub()[s1]), "point déplacé : la maison passe dans le bon secteur")
    jr = admin.get("/api/admin/journal").json()["entrees"]
    check(any(e["action"] == "adresse.corrigee" and "point déplacé de" in e["details"] for e in jr), "journal : point déplacé (mètres)")
    check(admin.put(u, json={"numero": "14", "nom_voie": "Rue des Écoles", "lat": a["lat"] + 0.1, "lon": a["lon"]}).status_code == 422, "point à plus de 3 km : refusé")
    check(admin.put(u, json={"numero": "14", "nom_voie": ""}).status_code == 422, "rue vide : refusée")
    check(TestClient(app).put(u, json={"numero": "1", "nom_voie": "x"}).status_code == 401, "réservé à l'admin")
    check(j.put(u, json={"numero": "1", "nom_voie": "x"}).status_code == 401, "pas pour les équipes")
    # retour à l'origine
    r = admin.delete(u)
    check(r.status_code == 200 and r.json()["label"] == a["label"] and not r.json().get("corrigee"), "retour à l'adresse d'origine")
    check(any(y["id"] == a["id"] for y in pub()[s1]), "origine : de retour dans son secteur")
    # renvoyer exactement l'origine efface aussi la correction
    admin.put(u, json={"numero": "99", "nom_voie": a["nom_voie"]})
    r = admin.put(u, json={"numero": a["numero"], "nom_voie": a["nom_voie"], "lat": a["lat"], "lon": a["lon"]}).json()
    check(not r.get("corrigee"), "mêmes valeurs que l'origine : plus marquée corrigée")
    check(admin.put("/api/admin/communes/courzieu/addresses/inconnue/correction", json={"numero": "1", "nom_voie": "x"}).status_code == 404, "adresse inconnue : 404")
print("ÉCHECS :", fails)
sys.exit(1 if fails else 0)
