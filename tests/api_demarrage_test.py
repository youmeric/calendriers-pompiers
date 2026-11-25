"""Guide de démarrage d'une nouvelle caserne (plateforme multi-casernes)."""
import os, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="demarrage-")
os.environ.update({"PLATFORM_DB_PATH": f"{TMP}/plateforme.db", "CASERNES_DIR": f"{TMP}/casernes", "PLATFORM_ADMIN_PASSWORD": "central-secret",
                   "PLATFORM_DOMAIN": "calendriers.test", "PIPELINE_DIR": f"{HERE}/fake_pipeline", "AUTO_BACKUP": "0"})
sys.path.insert(0, os.path.dirname(HERE))
from fastapi.testclient import TestClient  # noqa: E402
from backend.app import main  # noqa: E402

fails = 0
def check(c, m):
    global fails
    print(("OK  " if c else "FAIL") + " " + m)
    fails += 0 if c else 1

central = TestClient(main.app, base_url="http://admin.calendriers.test")
with central:
    central.post("/api/plateforme/login", json={"password": "central-secret"})
    central.post("/api/plateforme/casernes", json={"slug": "vaugneray", "nom": "Sapeurs-pompiers de Vaugneray", "admin_identifiant": "chef",
                                                    "admin_nom": "Paul", "admin_password": "motdepasse1"})
    c = TestClient(main.app, base_url="http://vaugneray.calendriers.test")
    check(c.get("/api/admin/demarrage").status_code == 401, "guide : connexion requise")
    c.post("/api/admin/login", json={"identifiant": "chef", "password": "motdepasse1"})
    st = c.get("/api/admin/demarrage").json()
    check(st["multi"] and not st["fait"] and not any(st["etapes"].values()), "nouvelle caserne : guide à faire, aucune étape faite")
    check(st["communes"] == [] and st["generation"] is None, "pas encore de communes")
    check(c.post("/api/admin/demarrage/secteurs").json()["crees"] == [], "sans commune : aucun secteur créé")
    # l'admin central télécharge les communes
    cid = central.get("/api/plateforme/casernes").json()["casernes"][0]["id"]
    central.post(f"/api/plateforme/casernes/{cid}/communes", json={"communes": [{"nom": "Vaugneray", "code_postal": "69670"}]})
    for _ in range(60):
        st = c.get("/api/admin/demarrage").json()
        if st["generation"] != "en_cours":
            break
        time.sleep(0.5)
    check(st["etapes"]["communes"] and len(st["communes"]) == 2 and not st["etapes"]["secteurs"], "communes prêtes, secteurs à créer")
    st = c.post("/api/admin/demarrage/secteurs").json()
    check(st["etapes"]["secteurs"] and len(st["crees"]) == 2 and all(x["secteurs"] for x in st["communes"]), "secteurs proposés créés dans chaque commune")
    check(len(c.get("/api/communes/courzieu").json()["sectors"]) == 4, "secteurs visibles sur le site")
    check(c.post("/api/admin/demarrage/secteurs").json()["crees"] == [], "deuxième fois : rien ne change (secteurs existants gardés)")
    c.put("/api/admin/settings", json={"asso_adresse": "Caserne, 69670 Vaugneray", "contact_email": "chef@exemple.fr"})
    c.post("/api/admin/personnes", json={"personnes": [{"nom": "Jean"}]})
    st = c.get("/api/admin/demarrage").json()
    check(st["etapes"]["association"] and st["etapes"]["equipe"] and not st["etapes"]["identite"], "association et équipe faites, logo pas encore")
    st = c.post("/api/admin/demarrage/fin").json()
    check(st["fait"], "guide terminé")
    jr = c.get("/api/admin/journal").json()["entrees"]
    check(any("guide de démarrage" in x["objet"] for x in jr), "journal")
print("ÉCHECS :", fails)
sys.exit(1 if fails else 0)
