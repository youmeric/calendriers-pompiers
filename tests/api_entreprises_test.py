"""Tournée des entreprises : adresses marquées entreprise, signalement par les équipes, retour au secteur."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _env  # noqa: E402,F401
from fastapi.testclient import TestClient  # noqa: E402
from backend.app.main import app  # noqa: E402

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
    s1 = secs[0]["id"]
    jean, eve = admin.post("/api/admin/personnes", json={"personnes": [{"nom": "Jean"}, {"nom": "Eve"}]}).json()["personnes"]
    admin.put(f"/api/admin/secteurs/{s1}/equipe", json={"membres": [{"personne_id": jean["id"], "role": "responsable"}]})
    admin.put("/api/admin/settings", json={"suivi_adresses": True, "dons_actifs": True})
    pub = lambda: admin.get("/api/communes/courzieu").json()["sectors"]  # noqa: E731
    check(all(s["kind"] == "secteur" for s in pub()), "au départ : pas de tournée des entreprises")
    a, b, c = (x for x in next(s for s in pub() if s["id"] == s1)["addresses"][:3])
    j = TestClient(app); j.post("/api/equipe/login", json={"code": jean["code"]})
    j.post(f"/api/communes/courzieu/addresses/{a['id']}/status", json={"status": "absent"})
    j.post("/api/equipe/notes", json={"slug": "courzieu", "address_id": a["id"], "note": "ouvert le matin"})

    # l'admin marque une entreprise
    r = admin.put(f"/api/admin/communes/courzieu/addresses/{a['id']}/entreprise", json={"nom": "Garage Martin"})
    check(r.status_code == 200 and r.json()["entreprise"] == "Garage Martin", "admin : adresse marquée entreprise")
    ent = next((s for s in pub() if s["kind"] == "entreprises"), None)
    check(ent and ent["nom"] == "Entreprises" and [x["id"] for x in ent["addresses"]] == [a["id"]] and ent["addresses"][0]["entreprise"] == "Garage Martin",
          "tournée des entreprises créée avec cette adresse (et son nom)")
    check(all(x["id"] != a["id"] for x in next(s for s in pub() if s["id"] == s1)["addresses"]), "elle sort de son secteur")
    check(len(ent["polygon"]) == 1 and ent["limite"] is None, "carte : un petit carré autour de l'entreprise")
    adm = admin.get("/api/admin/communes/courzieu").json()
    check(all(s["kind"] == "secteur" for s in adm["sectors"]), "éditeur des secteurs : la tournée des entreprises n'y est pas")
    # enregistrer les secteurs ne la supprime pas
    admin.put("/api/admin/communes/courzieu/sectors", json={"sectors": [{"id": s["id"], "nom": s["nom"], "couleur": s["couleur"], "polygon": s["polygon"]} for s in adm["sectors"]]})
    check(any(s["kind"] == "entreprises" for s in pub()), "enregistrer les secteurs : la tournée des entreprises reste")
    # équipe entreprises
    admin.put(f"/api/admin/secteurs/{ent['id']}/equipe", json={"membres": [{"personne_id": eve["id"], "role": "responsable"}]})
    e = TestClient(app); e.post("/api/equipe/login", json={"code": eve["code"]})
    t = e.get(f"/api/equipe/secteurs/{ent['id']}/suivi").json()
    check(t["statuses"][a["id"]]["status"] == "absent" and t["notes"][a["id"]]["note"] == "ouvert le matin", "équipe entreprises : statut et note suivis")
    check(e.post(f"/api/communes/courzieu/addresses/{a['id']}/status", json={"status": "fait"}).status_code == 200, "équipe entreprises : marque l'entreprise")
    d = e.post("/api/equipe/dons", json={"slug": "courzieu", "address_id": a["id"], "montant": 50, "mode": "cheque"}).json()
    check(d.get("id"), "équipe entreprises : don enregistré")
    check(j.post(f"/api/communes/courzieu/addresses/{b['id']}/status", json={"status": "fait"}).status_code == 200, "équipe du secteur : ses maisons normalement")
    bil = admin.get("/api/admin/bilan").json()
    row = next(x for x in bil["secteurs"] if x["sector_id"] == ent["id"])
    check(row["kind"] == "entreprises" and row["adresses"] == 1 and row["totaux"]["total"] == 50, "suivi admin : ligne « Entreprises » avec ses dons")
    reg = admin.get("/api/admin/fiscal").json()["registre"]
    check(any("(Garage Martin)" in x["adresse"] for x in reg), "registre : nom de l'entreprise avec l'adresse")

    # signalement par une équipe : « c'est une entreprise »
    sig = j.post("/api/equipe/signalements", json={"slug": "courzieu", "type": "entreprise", "address_id": b["id"], "entreprise": "Boulangerie Dupont"}).json()
    check(sig["type"] == "entreprise" and sig["entreprise"] == "Boulangerie Dupont", "équipe : signale une entreprise oubliée")
    rows = admin.get("/api/admin/signalements").json()["signalements"]
    x = next(r for r in rows if r["id"] == sig["id"])
    check(x["entreprise"] == "Boulangerie Dupont" and not x["deja_entreprise"], "admin : signalement avec le nom proposé")
    r = admin.post(f"/api/admin/signalements/{sig['id']}", json={"action": "entreprise", "entreprise": "Boulangerie Dupont & fils"})
    check(r.status_code == 200 and r.json()["statut"] == "traite", "admin : « Ajouter à la tournée des entreprises »")
    ent = next(s for s in pub() if s["kind"] == "entreprises")
    xb = next((y for y in ent["addresses"] if y["id"] == b["id"]), None)
    check(xb and xb["entreprise"] == "Boulangerie Dupont & fils", "elle est dans la tournée des entreprises (nom corrigé)")
    tj = j.get(f"/api/equipe/secteurs/{s1}/suivi").json()
    check(b["id"] not in tj["statuses"], "elle sort de la liste de l'équipe du secteur")
    # maison manquante signalée comme entreprise
    sig2 = j.post("/api/equipe/signalements", json={"slug": "courzieu", "type": "manquante", "sector_id": s1, "lat": c["lat"] + 0.0003, "lon": c["lon"],
                                                   "numero": "3", "nom_voie": "ZA des Platanes", "entreprise": "Menuiserie Roux"}).json()
    r = admin.post(f"/api/admin/signalements/{sig2['id']}", json={"action": "ajouter"}).json()
    ent = next(s for s in pub() if s["kind"] == "entreprises")
    check(any(y["id"] == r["adresse_ajoutee"] and y["entreprise"] == "Menuiserie Roux" for y in ent["addresses"]), "maison manquante « entreprise » : ajoutée directement à la tournée des entreprises")
    # ajout direct par l'admin
    r = admin.post("/api/admin/communes/courzieu/entreprises", json={"nom": "Scierie", "numero": "", "nom_voie": "Route du Bois", "lat": c["lat"], "lon": c["lon"] + 0.0004})
    check(r.status_code == 200 and r.json()["entreprise"] == "Scierie", "admin : ajouter une entreprise placée sur la carte")
    # retrait : retour automatique dans le secteur
    r = admin.delete(f"/api/admin/communes/courzieu/addresses/{a['id']}/entreprise")
    check(r.status_code == 200 and not r.json().get("entreprise"), "retirer de la tournée des entreprises")
    check(any(y["id"] == a["id"] for y in next(s for s in pub() if s["id"] == s1)["addresses"]), "elle revient automatiquement dans son secteur")
    tj = j.get(f"/api/equipe/secteurs/{s1}/suivi").json()
    check(tj["statuses"][a["id"]]["status"] == "fait" and any(dd["address_id"] == a["id"] for dd in tj["dons_autres"].get(a["id"], [])),
          "son historique revient avec elle (statut, don reçu par l'équipe entreprises pour information)")
    jr = admin.get("/api/admin/journal").json()["entrees"]
    check(any(x["action"] == "entreprise.ajout" for x in jr) and any(x["action"] == "entreprise.retrait" and "retour dans" in x["details"] for x in jr), "journal : ajout et retrait")
    check(admin.delete(f"/api/admin/communes/courzieu/addresses/{a['id']}/entreprise").status_code == 404, "retirer deux fois : 404")
    check(TestClient(app).put(f"/api/admin/communes/courzieu/addresses/{b['id']}/entreprise", json={"nom": "x"}).status_code == 401, "réservé à l'admin")

    # une seule tournée des entreprises pour les deux communes
    bautos = admin.get("/api/admin/communes/brussieu").json()["auto_sectors"]
    bsecs = admin.put("/api/admin/communes/brussieu/sectors", json={"sectors": bautos}).json()["sectors"]
    bpub = lambda: admin.get("/api/communes/brussieu").json()["sectors"]  # noqa: E731
    bx = next(s for s in bpub() if s["id"] == bsecs[0]["id"])["addresses"][0]
    admin.put(f"/api/admin/communes/brussieu/addresses/{bx['id']}/entreprise", json={"nom": "Fromagerie de Brussieu"})
    ents = [s for slug in ("courzieu", "brussieu") for s in admin.get(f"/api/communes/{slug}").json()["sectors"] if s["kind"] == "entreprises"]
    check(len({s["id"] for s in ents}) == 1 and len(ents) == 2, "une seule tournée des entreprises, présente dans les deux communes")
    check(any(y["id"] == bx["id"] for y in next(s for s in bpub() if s["kind"] == "entreprises")["addresses"]), "Brussieu : son entreprise dans la tournée")
    eid = ents[0]["id"]
    t = e.get(f"/api/equipe/secteurs/{eid}/suivi").json()
    check(t["slugs"] == ["courzieu", "brussieu"], "équipe entreprises : la tournée couvre Courzieu + Brussieu")
    r = e.post(f"/api/communes/brussieu/addresses/{bx['id']}/status", json={"status": "fait", "sector_id": eid})
    check(r.status_code == 200, "équipe entreprises : marque une entreprise de Brussieu")
    d = e.post("/api/equipe/dons", json={"slug": "brussieu", "address_id": bx["id"], "montant": 20, "mode": "especes", "sector_id": eid}).json()
    t = e.get(f"/api/equipe/secteurs/{eid}/suivi").json()
    check(t["statuses"][bx["id"]]["status"] == "fait" and any(x["id"] == d["id"] for x in t["dons"]), "suivi : statuts et dons des deux communes ensemble")
    check(e.get(f"/api/equipe/secteurs/{eid}/caisse").json()["attendu"]["especes"] == 20, "une seule caisse pour la tournée")
    rows = [x for x in admin.get("/api/admin/bilan").json()["secteurs"] if x["sector_id"] == eid]
    check(len(rows) == 1 and rows[0]["commune"] == "Courzieu + Brussieu" and rows[0]["adresses"] == 4, f"suivi admin : une ligne « Entreprises » (Courzieu + Brussieu)")
    ov = [x for x in admin.get("/api/equipe/apercu").json()["secteurs"] if x["sector_id"] == eid]
    check(len(ov) == 1 and ov[0]["adresses"] == 4 and ov[0]["secteur"] == "E Entreprises", "aperçu des tournées : une ligne « E Entreprises »")
    fis = [x for x in admin.get("/api/admin/fiscal").json()["secteurs"] if x["sector_id"] == eid]
    check(len(fis) == 1 and fis[0]["adresses"] == 4, "dossier comptable : une ligne pour la tournée")
    ba = [x for x in admin.get("/api/admin/bilan-annee").json()["secteurs"] if x["sector_id"] == eid]
    check(len(ba) == 1, "bilan de l'année : une ligne pour la tournée")
    sig = e.post("/api/equipe/signalements", json={"slug": "brussieu", "type": "autre", "address_id": bx["id"], "sector_id": eid, "note": "fermé le lundi"})
    check(sig.status_code == 200, "signalement depuis une entreprise de Brussieu")
    # anciennes tournées par commune (version précédente) : fusionnées au démarrage
    import sqlite3
    from backend.app import db as dbm
    con = sqlite3.connect(os.environ["DB_PATH"])
    old = con.execute("INSERT INTO sectors (commune_slug, position, nom, couleur, polygon, updated_at, kind) VALUES "
                      "('brussieu', 1000, 'Entreprises', '#475569', '[]', '2026-11-18', 'entreprises')").lastrowid
    con.execute("UPDATE sectors SET commune_slug = 'courzieu' WHERE id = ?", (eid,))
    con.execute("UPDATE dons SET sector_id = ? WHERE id = ?", (old, d["id"]))
    con.execute("INSERT INTO sector_team (sector_id, personne_id, role, position) VALUES (?, ?, 'equipier', 0)", (old, jean["id"]))
    con.commit(); con.close()
    dbm.init_db()
    ents = {s["id"] for slug in ("courzieu", "brussieu") for s in admin.get(f"/api/communes/{slug}").json()["sectors"] if s["kind"] == "entreprises"}
    check(ents == {eid}, "anciennes tournées par commune : fusionnées en une seule")
    check(dbm.get_don(d["id"])["sector_id"] == eid, "fusion : les dons rejoignent la tournée gardée")
    membres = {m["personne_id"] for m in dbm.get_teams()[eid]["membres"]}
    check(membres == {eve["id"], jean["id"]}, "fusion : les deux équipes réunies")
print("ÉCHECS :", fails)
sys.exit(1 if fails else 0)
