"""Secteurs modifiés en pleine tournée : historique qui suit la maison, dons de l'ancienne équipe,
aperçu avant enregistrement, gestes hors réseau acceptés pour l'ancienne équipe."""
import os, sys, time, sqlite3, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _env  # noqa: E402,F401
from fastapi.testclient import TestClient  # noqa: E402
from backend.app.main import app  # noqa: E402
from backend.app import db  # noqa: E402
from backend.app.geo import normalize_polys  # noqa: E402

fails = 0
def check(c, m):
    global fails
    print(("OK  " if c else "FAIL") + " " + m)
    fails += 0 if c else 1

def square(lat, lon, d=0.00005):
    return [[[lat - d, lon - d], [lat - d, lon + d], [lat + d, lon + d], [lat + d, lon - d]]]

iso = lambda t: t.isoformat().replace("+00:00", "Z")  # noqa: E731
admin = TestClient(app)
with admin:
    admin.post("/api/admin/login", json={"password": "secret123"})
    autos = admin.get("/api/admin/communes/courzieu").json()["auto_sectors"][:3]
    base = [{"nom": a["nom"], "couleur": a["couleur"], "polygon": a["polygon"]} for a in autos]
    secs = admin.put("/api/admin/communes/courzieu/sectors", json={"sectors": base}).json()["sectors"]
    s1, s2, s3 = (x["id"] for x in secs)
    for x, s in zip(base, secs):
        x["id"] = s["id"]
    jean, paul = admin.post("/api/admin/personnes", json={"personnes": [{"nom": "Jean Resp"}, {"nom": "Paul Resp"}]}).json()["personnes"]
    admin.put(f"/api/admin/secteurs/{s1}/equipe", json={"membres": [{"personne_id": jean["id"], "role": "responsable"}]})
    admin.put(f"/api/admin/secteurs/{s2}/equipe", json={"membres": [{"personne_id": paul["id"], "role": "responsable"}]})
    admin.put("/api/admin/settings", json={"suivi_adresses": True, "dons_actifs": True})
    pub = {s["id"]: s["addresses"] for s in admin.get("/api/communes/courzieu").json()["sectors"]}
    h = pub[s1][:5]
    p_other = pub[s2][0]["id"]
    j = TestClient(app); j.post("/api/equipe/login", json={"code": jean["code"]})
    p = TestClient(app); p.post("/api/equipe/login", json={"code": paul["code"]})
    url = lambda aid: f"/api/communes/courzieu/addresses/{aid}/status"  # noqa: E731
    j.post(url(h[0]["id"]), json={"status": "fait"})
    don = j.post("/api/equipe/dons", json={"slug": "courzieu", "address_id": h[0]["id"], "montant": 10, "mode": "especes"}).json()
    j.post("/api/equipe/notes", json={"slug": "courzieu", "address_id": h[0]["id"], "note": "chien"})
    j.post(url(h[1]["id"]), json={"status": "absent"})

    # B : aperçu avant d'enregistrer (3 maisons passent de s1 à s2, dont 2 déjà passées)
    moved = [dict(base[1], polygon=normalize_polys(base[1]["polygon"]) + [square(x["lat"], x["lon"]) for x in h[:3]]), base[0], base[2]]
    imp = admin.post("/api/admin/communes/courzieu/sectors/impact", json={"sectors": moved}).json()
    check(imp["deplacees"] >= 3, f"aperçu : maisons déplacées comptées ({imp['deplacees']})")
    m = {x["address_id"]: x for x in imp["maisons"]}
    check(set(m) == {h[0]["id"], h[1]["id"]}, "aperçu : seules les 2 maisons déjà passées sont listées")
    check(m[h[0]["id"]]["status"] == "fait" and m[h[0]["id"]]["nb_dons"] == 1 and m[h[0]["id"]]["montant"] == 10 and m[h[0]["id"]]["note"]
          and m[h[0]["id"]]["de"] == base[0]["nom"] and m[h[0]["id"]]["vers"] == base[1]["nom"], "aperçu : statut, don, note, de → vers")
    check(m[h[1]["id"]]["status"] == "absent" and not imp["supprimes"], "aperçu : maison à repasser, aucun secteur supprimé")
    check(j.get(f"/api/equipe/secteurs/{s1}/suivi").json()["statuses"].get(h[0]["id"]), "aperçu : rien n'est enregistré")
    imp_del = admin.post("/api/admin/communes/courzieu/sectors/impact", json={"sectors": [base[1], base[2]]}).json()
    check([(x["id"], x["membres"], x["nb_dons"], x["montant"]) for x in imp_del["supprimes"]] == [(s1, 1, 1, 10)], "aperçu : secteur supprimé avec son équipe et ses dons")
    check(TestClient(app).post("/api/admin/communes/courzieu/sectors/impact", json={"sectors": moved}).status_code == 401, "aperçu réservé à l'admin")

    time.sleep(0.05)
    check(admin.put("/api/admin/communes/courzieu/sectors", json={"sectors": moved}).status_code == 200, "secteurs enregistrés")
    jr = admin.get("/api/admin/journal").json()["entrees"]
    e = next((x for x in jr if x["action"] == "secteurs.maisons"), None)
    check(e and "2 maison(s)" in e["details"] and "fait" in e["details"] and "10,00 €" in e["details"], "journal : maisons déplacées avec statut et don")

    # A : la nouvelle équipe voit l'historique et le don (pour information)
    tp = p.get(f"/api/equipe/secteurs/{s2}/suivi").json()
    check(tp["statuses"][h[0]["id"]]["status"] == "fait" and tp["statuses"][h[1]["id"]]["status"] == "absent", "nouvelle équipe : fait / à repasser conservés")
    check(tp["notes"][h[0]["id"]]["note"] == "chien", "nouvelle équipe : note conservée")
    da = tp["dons_autres"].get(h[0]["id"]) or []
    check(len(da) == 1 and da[0]["montant"] == 10 and da[0]["secteur"].endswith(base[0]["nom"]) and "tx_code" not in da[0], "nouvelle équipe : don reçu par l'ancienne équipe (pour information)")
    check(all(d["address_id"] != h[0]["id"] for d in tp["dons"]) and tp["totaux"]["total"] == 0, "nouvelle équipe : pas dans sa caisse")
    tj = j.get(f"/api/equipe/secteurs/{s1}/suivi").json()
    check(any(d["id"] == don["id"] for d in tj["dons"]) and tj["totaux"]["total"] == 10 and not tj["dons_autres"], "ancienne équipe : le don reste dans sa caisse")
    check(p.delete(f"/api/equipe/dons/{don['id']}").status_code == 403, "nouvelle équipe : ne peut pas annuler le don de l'autre")

    # C : gestes faits avant le changement (hors réseau) acceptés pour l'ancienne équipe
    h2 = h[2]["id"]
    check(j.post(url(h2), json={"status": "fait"}).status_code == 200, "liste pas encore rafraîchie (moins de 15 min) : accepté")
    con = sqlite3.connect(os.environ["DB_PATH"])  # on vieillit l'historique : découpage d'origine il y a 3 h, changement il y a 1 h
    rows = con.execute("SELECT id, saved_at FROM sector_versions ORDER BY id").fetchall()
    for k, (vid, at) in enumerate(rows):
        con.execute("UPDATE sector_versions SET saved_at = ? WHERE id = ?", ((dt.datetime.fromisoformat(at) - dt.timedelta(hours=3 if k == 0 else 1)).isoformat(), vid))
    con.commit()
    last = dt.datetime.fromisoformat(con.execute("SELECT MAX(saved_at) FROM sector_versions").fetchone()[0])
    con.close()
    before_change = last - dt.timedelta(seconds=30)
    check(j.post(url(h2), json={"status": "fait"}).status_code == 403, "geste fait après le changement (plus de 15 min) : refusé à l'ancienne équipe")
    r = j.post(url(h2), json={"status": "fait", "sector_id": s1, "fait_le": iso(before_change)})
    check(r.status_code == 200, f"hors réseau : statut fait avant le changement accepté ({r.status_code})")
    d2 = j.post("/api/equipe/dons", json={"slug": "courzieu", "address_id": h2, "montant": 5, "mode": "especes", "client_id": "abc123",
                                          "sector_id": s1, "fait_le": iso(before_change)}).json()
    check(next((x["sector_id"] for x in db.list_dons(db.current_annee()) if x["id"] == d2.get("id")), None) == s1, "hors réseau : don compté dans la caisse de l'équipe qui l'a reçu")
    check(j.post("/api/equipe/notes", json={"slug": "courzieu", "address_id": h2, "note": "rappeler", "sector_id": s1, "fait_le": iso(before_change)}).status_code == 200, "hors réseau : note acceptée")
    check(j.post("/api/equipe/signalements", json={"slug": "courzieu", "type": "vide", "address_id": h2, "sector_id": s1, "fait_le": iso(before_change)}).status_code == 200, "hors réseau : signalement accepté")
    check(j.post(url(h2), json={"status": "fait", "fait_le": iso(before_change)}).status_code == 200, "ancienne file (sans secteur) : acceptée aussi")
    check(j.post(url(h2), json={"status": "refus", "fait_le": before_change.replace(tzinfo=None).isoformat()}).status_code == 200, "heure sans fuseau : comprise en UTC")
    jr = admin.get("/api/admin/journal").json()["entrees"]
    check(any("passée depuis dans un autre secteur" in x["objet"] for x in jr if x["action"] == "statut"), "journal : geste noté « maison passée dans un autre secteur »")
    check(j.post(url(h2), json={"status": "fait", "fait_le": iso(dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=8))}).status_code == 403, "plus de 7 jours : refusé")
    check(j.post(url(p_other), json={"status": "fait", "sector_id": s1, "fait_le": iso(before_change)}).status_code == 403, "maison jamais dans son secteur : refusé")
    check(p.post(url(h2), json={"status": "absent"}).status_code == 200, "nouvelle équipe : marque normalement")
    check(p.post(url(h[3]["id"]), json={"status": "fait", "sector_id": s2}).status_code == 403, "nouvelle équipe : pas les maisons restées dans l'autre secteur")
    admin.put("/api/admin/communes/courzieu/sectors", json={"sectors": [moved[0], moved[2]]})
    jr = admin.get("/api/admin/journal").json()["entrees"]
    check(any(x["action"] == "secteurs.supprime" and "équipe de 1 personne" in x["details"] for x in jr), "journal : secteur supprimé avec son équipe")
print("ÉCHECS :", fails)
sys.exit(1 if fails else 0)
