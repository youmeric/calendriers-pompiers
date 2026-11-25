"""Bascule d'une installation simple (Courzieu) vers la plateforme Almaneo : toutes les données suivent,
les téléphones restent connectés, la base d'origine n'est pas touchée, un essai n'écrit rien."""
import hashlib, json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TMP = tempfile.mkdtemp(prefix="bascule-")
SRC_DB, SRC_DATA = f"{TMP}/db/status.db", f"{TMP}/sectors"
os.makedirs(f"{TMP}/db", exist_ok=True)
subprocess.run([sys.executable, f"{HERE}/fake_data.py", SRC_DATA], check=True)

# 1) une installation simple en service, avec des données (processus à part : autre configuration)
SOURCE = r'''
import json, os, sys
sys.path.insert(0, os.environ["ROOT"])
from fastapi.testclient import TestClient
from backend.app.main import app
a = TestClient(app, base_url="http://spcourzieu.fr")
with a:
    a.post("/api/admin/login", json={"password": "ancien-mot-de-passe"})
    autos = a.get("/api/admin/communes/courzieu").json()["auto_sectors"]
    s1 = a.put("/api/admin/communes/courzieu/sectors", json={"sectors": autos}).json()["sectors"][0]["id"]
    jean, = a.post("/api/admin/personnes", json={"personnes": [{"nom": "Jean Dupont"}]}).json()["personnes"]
    a.put(f"/api/admin/secteurs/{s1}/equipe", json={"membres": [{"personne_id": jean["id"], "role": "responsable"}]})
    a.put("/api/admin/settings", json={"suivi_adresses": True, "dons_actifs": True})
    a.post("/api/admin/comptes", json={"identifiant": "tresorier", "nom": "Trésorier", "role_id": 1, "password": "tresorier123"})
    adr = a.get("/api/communes/courzieu").json()["sectors"][0]["addresses"][0]["id"]
    j = TestClient(app, base_url="http://spcourzieu.fr")
    j.post("/api/equipe/login", json={"code": jean["code"]})
    j.post(f"/api/communes/courzieu/addresses/{adr}/status", json={"status": "fait"})
    j.post("/api/equipe/dons", json={"slug": "courzieu", "address_id": adr, "montant": 12, "mode": "especes"})
    a.post("/api/admin/dons-annexes", json={"montant": 20, "mode": "especes", "origine": "boite"})
    a.post("/api/admin/sauvegardes")
    print(json.dumps({"code": jean["code"], "cookie": j.cookies.get("equipe_session"), "s1": s1, "adr": adr}))
'''
env = {**os.environ, "ROOT": ROOT, "DB_PATH": SRC_DB, "SECTORS_DATA_DIR": SRC_DATA, "ADMIN_PASSWORD": "ancien-mot-de-passe", "AUTO_BACKUP": "0"}
for k in ("PLATFORM_DB_PATH", "CASERNES_DIR"):
    env.pop(k, None)
out = subprocess.run([sys.executable, "-c", SOURCE], env=env, capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1]
src = json.loads(out)
digest = lambda: hashlib.sha256(open(SRC_DB, "rb").read()).hexdigest()  # noqa: E731
before = digest()

# 2) la plateforme, et la bascule
os.environ.update({"PLATFORM_DB_PATH": f"{TMP}/plateforme/plateforme.db", "CASERNES_DIR": f"{TMP}/plateforme/casernes",
                   "PLATFORM_ADMIN_PASSWORD": "central-secret", "PLATFORM_DOMAIN": "almaneo.test", "AUTO_BACKUP": "0",
                   "ADMIN_PASSWORD": "ancien-mot-de-passe"})
sys.path.insert(0, ROOT)
from fastapi.testclient import TestClient  # noqa: E402
from backend.app import basculer, main, plateforme  # noqa: E402

fails = 0
def check(c, m):
    global fails
    print(("OK  " if c else "FAIL") + " " + m)
    fails += 0 if c else 1

args = ["--source-db", SRC_DB, "--source-data", SRC_DATA, "--slug", "courzieu", "--adresse", "spcourzieu.fr",
        "--admin-identifiant", "chef.courzieu", "--admin-nom", "Chef de Courzieu"]
check(basculer.main(args + ["--essai"]) == 0 and plateforme.list_casernes() == [], "essai : rien n'est écrit")
check(basculer.main(args) == 0, "bascule faite")
check(basculer.main(args) == 2, "deuxième fois : refusée (la caserne existe déjà)")
check(digest() == before, "base d'origine intacte (retour arrière possible)")

c = TestClient(main.app, base_url="http://spcourzieu.fr")
with c:
    check([x["slug"] for x in c.get("/api/communes").json()["communes"]] == ["courzieu", "brussieu"], "communes reprises")
    check(any(s["id"] == src["s1"] for s in c.get("/api/communes/courzieu").json()["sectors"]), "secteurs repris (mêmes numéros)")
    j = TestClient(main.app, base_url="http://spcourzieu.fr")
    j.cookies.set("equipe_session", src["cookie"])
    check(j.get("/api/equipe/moi").status_code == 200, "téléphone déjà connecté : reste connecté après la bascule")
    t = j.get(f"/api/equipe/secteurs/{src['s1']}/suivi").json()
    check(t["statuses"][src["adr"]]["status"] == "fait" and t["totaux"]["total"] == 12, "suivi et dons de l'équipe repris")
    check(TestClient(main.app, base_url="http://courzieu.almaneo.test").post("/api/equipe/login", json={"code": src["code"]}).status_code == 200,
          "même code d'accès, aussi sur courzieu.almaneo")
    check(c.post("/api/admin/login", json={"identifiant": "", "password": "ancien-mot-de-passe"}).status_code == 422, "plus de compte principal commun")
    check(c.post("/api/admin/login", json={"identifiant": "chef.courzieu", "password": "ancien-mot-de-passe"}).status_code == 200,
          "compte administrateur nominatif créé (mot de passe de l'ancien compte principal)")
    check(TestClient(main.app, base_url="http://spcourzieu.fr").post("/api/admin/login", json={"identifiant": "tresorier", "password": "tresorier123"}).status_code == 200,
          "les comptes existants (trésorier) marchent toujours")
    f = c.get("/api/admin/fiscal").json()
    check(f["synthese"]["total"] == 32 and len(f["registre"]) == 2, "registre et totaux repris (don de l'équipe + don hors tournée)")
    home = c.get("/").text
    check("Sapeurs-pompiers de Courzieu" in home and "/logo?v=" in home and "propulsé par <b>Almaneo</b>" in home, "identité de Courzieu (nom, écusson)")
    check(c.get(c.get("/api/admin/settings").json()["caserne_logo"]).content.startswith(b"\x89PNG"), "écusson de Courzieu repris")
    check(c.get("/api/admin/demarrage").json()["fait"], "pas de guide de démarrage pour une caserne déjà en service")
    check(c.get("/api/admin/sauvegardes").json()["sauvegardes"], "sauvegardes reprises")
    check(any(x["action"] == "plateforme.bascule" for x in c.get("/api/admin/journal").json()["entrees"]), "journal de la caserne : bascule notée")
    p = TestClient(main.app, base_url="http://admin.almaneo.test")
    p.post("/api/plateforme/login", json={"password": "central-secret"})
    cs = p.get("/api/plateforme/casernes").json()["casernes"]
    check(len(cs) == 1 and cs[0]["slug"] == "courzieu" and cs[0]["hosts"] == ["spcourzieu.fr"] and cs[0]["stats"]["personnes"] == 1, "admin central : Courzieu, première caserne d'Almaneo")
print("ÉCHECS :", fails)
sys.exit(1 if fails else 0)
