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
    st = admin.get("/api/admin/settings").json()
    check(st["avancement"] == "passees", "par défaut : maisons passées (comme avant)")
    autos = admin.get("/api/admin/communes/courzieu").json()["auto_sectors"]
    s1 = admin.put("/api/admin/communes/courzieu/sectors", json={"sectors": autos}).json()["sectors"][0]["id"]
    jean, = admin.post("/api/admin/personnes", json={"personnes": [{"nom": "Jean"}]}).json()["personnes"]
    admin.put(f"/api/admin/secteurs/{s1}/equipe", json={"membres": [{"personne_id": jean["id"], "role": "responsable"}]})
    for v in ("terminees", "faites", "passees"):
        r = admin.put("/api/admin/settings", json={"avancement": v})
        check(r.status_code == 200 and r.json()["avancement"] == v, f"réglage « {v} » enregistré")
    check(admin.put("/api/admin/settings", json={"avancement": "n'importe"}).status_code == 422, "valeur inconnue refusée")
    admin.put("/api/admin/settings", json={"avancement": "faites"})
    j = TestClient(app); j.post("/api/equipe/login", json={"code": jean["code"]})
    check(j.get("/api/equipe/moi").json()["avancement"] == "faites", "appli équipe : réglage transmis")
    check(any(x["action"] == "reglages" and "avancement" in x["details"] for x in admin.get("/api/admin/journal").json()["entrees"]), "journal : changement noté")
    # rôle « Chef de tournée » (suivi) : peut le changer ; trésorier (dons) : non
    rl = admin.get("/api/admin/comptes").json()["roles"]
    chef = next(r for r in rl if "suivi" in r["permissions"])
    treso = next((r for r in rl if r["permissions"] == ["dons"] or ("dons" in r["permissions"] and "suivi" not in r["permissions"] and "reglages" not in r["permissions"])), None)
    def compte(ident, role_id):
        r = admin.post("/api/admin/comptes", json={"identifiant": ident, "nom": ident, "role_id": role_id, "password": "motdepasse123"})
        c = TestClient(app); c.post("/api/admin/login", json={"identifiant": ident, "password": "motdepasse123"})
        return r, c
    r, c = compte("chef", chef["id"])
    check(r.status_code == 200 and c.put("/api/admin/settings", json={"avancement": "terminees"}).status_code == 200, "chef de tournée : peut changer le calcul")
    check(c.get("/api/admin/settings").json()["avancement"] == "terminees", "chef de tournée : voit le réglage")
    if treso:
        r, t = compte("treso", treso["id"])
        check(t.put("/api/admin/settings", json={"avancement": "faites"}).status_code == 403, "trésorier : ne peut pas le changer")
print("ÉCHECS :", fails)
sys.exit(1 if fails else 0)
