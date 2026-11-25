"""Dons hors tournée (adresse inconnue, boîte aux lettres de la caserne…) : saisis par le trésorier,
comptés dans tous les totaux, au registre, et déjà « remis » dans la chaîne espèces / chèques."""
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
    s1 = admin.put("/api/admin/communes/courzieu/sectors", json={"sectors": autos}).json()["sectors"][0]["id"]
    jean, = admin.post("/api/admin/personnes", json={"personnes": [{"nom": "Jean"}]}).json()["personnes"]
    admin.put(f"/api/admin/secteurs/{s1}/equipe", json={"membres": [{"personne_id": jean["id"], "role": "responsable"}]})
    admin.put("/api/admin/settings", json={"suivi_adresses": True, "dons_actifs": True})
    a = admin.get("/api/communes/courzieu").json()["sectors"][0]["addresses"][0]
    j = TestClient(app); j.post("/api/equipe/login", json={"code": jean["code"]})
    j.post("/api/equipe/dons", json={"slug": "courzieu", "address_id": a["id"], "montant": 10, "mode": "especes"})

    url = "/api/admin/dons-annexes"
    r = admin.post(url, json={"montant": 20, "mode": "especes", "origine": "boite", "note": "enveloppe sans nom"})
    check(r.status_code == 200 and r.json()["numero"] == 2 and r.json()["origine_label"] == "Boîte aux lettres de la caserne", "don déposé dans la boîte aux lettres : n° 2 au registre")
    r2 = admin.post(url, json={"montant": 15, "mode": "cheque", "origine": "decale", "note": "M. Martin", "tx_code": "1234567"})
    check(r2.status_code == 200, "don reçu après la tournée (chèque)")
    check(admin.post(url, json={"montant": 0, "mode": "especes", "origine": "boite"}).status_code == 422, "montant nul refusé")
    check(admin.post(url, json={"montant": 5, "mode": "especes", "origine": "nulle-part"}).status_code == 422, "origine inconnue refusée")
    check(TestClient(app).post(url, json={"montant": 5, "mode": "especes", "origine": "boite"}).status_code == 401, "réservé à la console")
    check(j.post(url, json={"montant": 5, "mode": "especes", "origine": "boite"}).status_code == 401, "pas pour les équipes")
    lst = admin.get(url).json()
    check(len(lst["dons"]) == 2 and lst["totaux"]["total"] == 35, "liste des dons hors tournée : 35 €")

    b = admin.get("/api/admin/bilan").json()
    check(b["totaux"]["total"] == 45 and b["annexes"]["total"] == 35 and b["annexes"]["nb"] == 2, "suivi : total 45 € dont 35 € hors tournée")
    check(sum(x["totaux"]["total"] for x in b["secteurs"]) == 10, "les secteurs gardent leurs propres dons (10 €)")
    tj = j.get(f"/api/equipe/secteurs/{s1}/suivi").json()
    check(tj["totaux"]["total"] == 10 and j.get(f"/api/equipe/secteurs/{s1}/caisse").json()["attendu"]["especes"] == 10, "caisse de l'équipe : inchangée")
    ba = admin.get("/api/admin/bilan-annee").json()
    y = str(ba["annee"])
    check(ba["totaux"][y]["dons"]["total"] == 45 and ba["annexes"][y]["total"] == 35, "bilan de l'année : 45 € dont 35 € hors tournée")
    f = admin.get("/api/admin/fiscal").json()
    check(f["synthese"]["total"] == 45 and f["synthese"]["nb"] == 3, "dossier comptable : 45 € pour 3 dons")
    reg = {x["numero"]: x for x in f["registre"]}
    check(reg[2]["secteur"] == "Dons hors tournée" and reg[2]["adresse"] == "Boîte aux lettres de la caserne" and reg[2]["annexe"], "registre : origine à la place de l'adresse")
    row = next(x for x in f["secteurs"] if x["sector_id"] == 0)
    check(row["total"] == 35 and row["reste"] == 0, "dossier : ligne « Dons hors tournée », rien à remettre")
    ch = f["chaine"]
    check(ch["encaisse"]["especes"] == 30 and ch["reste_terrain"]["especes"] == 10 and ch["direct"]["especes"] == 20 and ch["reste_terrain"]["cheques"] == 0,
          "chaîne : les dons hors tournée sont déjà chez le trésorier (reste sur le terrain = 10 € de l'équipe)")
    csv = admin.get("/api/admin/fiscal/registre.csv").content.decode("utf-8")
    check("Boîte aux lettres de la caserne" in csv and "Dons hors tournée" in csv, "export du registre")
    ex = admin.get("/api/admin/dons").json()["dons"]
    check(any(d["adresse"] == "Reçu après la tournée (adresse inconnue)" for d in ex), "export Excel des dons")
    # annulation
    check(admin.delete(f"{url}/{r2.json()['id']}?motif=doublon").status_code == 200, "annulation avec motif")
    f = admin.get("/api/admin/fiscal").json()
    check(f["synthese"]["total"] == 30 and f["synthese"]["annules"]["nb"] == 1, "annulé : sorti des totaux, gardé au registre")
    check(admin.delete(f"{url}/{r2.json()['id']}").status_code == 404, "annuler deux fois : refusé")
    don_equipe = next(x for x in f["registre"] if x["numero"] == 1)
    check(admin.delete(f"{url}/{don_equipe['id']}").status_code == 404, "un don d'une équipe ne s'annule pas par ici")
    jr = admin.get("/api/admin/journal").json()["entrees"]
    check(any(x["action"] == "don.annexe" for x in jr), "journal : don hors tournée")
print("ÉCHECS :", fails)
sys.exit(1 if fails else 0)
