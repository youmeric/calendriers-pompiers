"""Version multi-casernes : admin central, casernes cloisonnées (base, données, sessions), suspension,
option abonnement, tâches de fond par caserne."""
import asyncio, os, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="multi-")
os.environ.update({"PLATFORM_DB_PATH": f"{TMP}/plateforme.db", "CASERNES_DIR": f"{TMP}/casernes",
                   "PLATFORM_ADMIN_PASSWORD": "central-secret", "PLATFORM_DOMAIN": "calendriers.test",
                   "PIPELINE_DIR": f"{HERE}/fake_pipeline", "AUTO_BACKUP": "0", "ADMIN_PASSWORD": "ne-doit-pas-servir"})
sys.path.insert(0, os.path.dirname(HERE))
from fastapi.testclient import TestClient  # noqa: E402
from backend.app import main, plateforme  # noqa: E402

fails = 0
def check(c, m):
    global fails
    print(("OK  " if c else "FAIL") + " " + m)
    fails += 0 if c else 1

C = lambda host: TestClient(main.app, base_url=f"http://{host}")  # noqa: E731
central = C("admin.calendriers.test")
with central:
    r = central.get("/", follow_redirects=False)
    check(r.status_code in (302, 307) and r.headers["location"] == "/plateforme", "adresse de l'admin central : renvoie vers /plateforme")
    check(central.get("/plateforme").status_code == 200, "page de l'admin central")
    check(central.get("/api/plateforme/casernes").status_code == 401, "admin central : connexion requise")
    check(central.post("/api/plateforme/login", json={"password": "faux"}).status_code == 401, "mauvais mot de passe refusé")
    check(central.post("/api/plateforme/login", json={"password": "central-secret"}).status_code == 200, "connexion à l'admin central")
    mk = lambda **kw: central.post("/api/plateforme/casernes", json={"admin_nom": "Chef", "admin_password": "motdepasse1", **kw})  # noqa: E731
    r = mk(slug="courzieu", nom="Sapeurs-pompiers de Courzieu", admin_identifiant="chef.courzieu",
           communes=[{"nom": "Courzieu", "code_postal": "69690"}])
    check(r.status_code == 200 and r.json()["url"] == "https://courzieu.calendriers.test/", f"caserne Courzieu créée ({r.status_code})")
    a_id = r.json()["id"]
    r = mk(slug="vaugneray", nom="Sapeurs-pompiers de Vaugneray", admin_identifiant="chef.vaugneray",
           hosts=["pompiers-vaugneray.fr"], communes=[{"nom": "Vaugneray", "code_postal": "69670"}])
    check(r.status_code == 200 and r.json()["url"] == "https://pompiers-vaugneray.fr/", "caserne Vaugneray créée, avec son propre nom de domaine")
    b_id = r.json()["id"]
    check(mk(slug="courzieu", nom="x", admin_identifiant="x1").status_code == 409, "identifiant de caserne déjà pris : refusé")
    check(mk(slug="admin", nom="x", admin_identifiant="x1").status_code == 422, "identifiant réservé (admin) : refusé")
    check(mk(slug="autre", nom="x", admin_identifiant="x1", hosts=["pompiers-vaugneray.fr"]).status_code == 409, "adresse déjà utilisée : refusée")
    for _ in range(60):  # téléchargement des communes (pipeline factice)
        gens = [c["generation"]["statut"] for c in central.get("/api/plateforme/casernes").json()["casernes"]]
        if all(g != "en_cours" for g in gens):
            break
        time.sleep(0.5)
    cs = {c["slug"]: c for c in central.get("/api/plateforme/casernes").json()["casernes"]}
    check(cs["courzieu"]["generation"]["statut"] == "ok" and "Courzieu" in cs["courzieu"]["stats"]["communes"], "communes téléchargées pour la caserne")
    check(cs["vaugneray"]["stats"]["comptes"] == 1, "compte administrateur créé dans la caserne")

    a, b = C("courzieu.calendriers.test"), C("pompiers-vaugneray.fr")
    check([c["slug"] for c in a.get("/api/communes").json()["communes"]] == ["courzieu", "brussieu"], "caserne : ses communes")
    check(a.get("/api/public/caserne").json()["nom"] == "Sapeurs-pompiers de Courzieu", "caserne reconnue par son adresse")
    check(a.post("/api/admin/login", json={"identifiant": "", "password": "ne-doit-pas-servir"}).status_code == 422,
          "pas de compte principal commun (ADMIN_PASSWORD) dans une caserne")
    check(a.post("/api/admin/login", json={"identifiant": "chef.courzieu", "password": "motdepasse1"}).status_code == 200, "Courzieu : connexion de son admin")
    check(b.post("/api/admin/login", json={"identifiant": "chef.courzieu", "password": "motdepasse1"}).status_code == 401, "Vaugneray : le compte de Courzieu n'existe pas")
    check(b.post("/api/admin/login", json={"identifiant": "chef.vaugneray", "password": "motdepasse1"}).status_code == 200, "Vaugneray : connexion de son admin")
    a.post("/api/admin/personnes", json={"personnes": [{"nom": "Jean de Courzieu"}]})
    pa = a.get("/api/admin/equipes").json()["personnes"]
    pb = b.get("/api/admin/equipes").json()["personnes"]
    check(len(pa) == 1 and pb == [], "données cloisonnées : les personnes de Courzieu n'apparaissent pas à Vaugneray")
    # une session d'une caserne ne vaut rien ailleurs (même cookie présenté à l'autre adresse)
    stolen = C("pompiers-vaugneray.fr")
    stolen.cookies.set("admin_session", a.cookies.get("admin_session"))
    check(stolen.get("/api/admin/me").status_code == 401, "session de Courzieu refusée à Vaugneray")
    code = pa[0]["code"]
    check(C("courzieu.calendriers.test").post("/api/equipe/login", json={"code": code}).status_code == 200
          and C("pompiers-vaugneray.fr").post("/api/equipe/login", json={"code": code}).status_code == 401, "code d'équipe valable seulement dans sa caserne")
    check(a.get("/api/plateforme/casernes").status_code == 404, "l'admin central n'est pas joignable depuis l'adresse d'une caserne")
    check(C("inconnue.example.org").get("/api/communes").status_code == 404, "adresse inconnue : aucune caserne")

    # suspension
    central.put(f"/api/plateforme/casernes/{b_id}", json={"statut": "suspendue"})
    check(b.get("/api/communes").status_code == 503 and "suspendu" in b.get("/").text, "caserne suspendue : son site ne répond plus")
    check(a.get("/api/communes").status_code == 200, "les autres casernes continuent")
    central.put(f"/api/plateforme/casernes/{b_id}", json={"statut": "active"})
    check(b.get("/api/communes").status_code == 200, "réactivée")

    # option abonnement : sans effet tant qu'elle n'est pas activée
    central.put(f"/api/plateforme/casernes/{b_id}", json={"abonnement": "expire", "abonnement_fin": "2026-01-31"})
    check(b.get("/api/public/caserne").json()["abonnement"]["actif"] is True, "option abonnement désactivée : aucune caserne bloquée")
    central.put("/api/plateforme/reglages", json={"abonnements_actifs": True})
    ab = b.get("/api/public/caserne").json()["abonnement"]
    check(ab["option"] and ab["actif"] is False and ab["formule"] == "expire", "option activée : abonnement expiré signalé")
    check(a.get("/api/public/caserne").json()["abonnement"]["actif"] is True, "caserne « gratuit » : toujours libre")
    central.put(f"/api/plateforme/casernes/{b_id}", json={"abonnement": "actif", "abonnement_fin": "2099-12-31"})
    check(b.get("/api/public/caserne").json()["abonnement"]["actif"] is True, "abonnement renouvelé")

    # compte administrateur ajouté par l'admin central (mot de passe perdu)
    r = central.post(f"/api/plateforme/casernes/{a_id}/comptes", json={"identifiant": "secours", "nom": "Secours", "password": "motdepasse2"})
    check(r.status_code == 200 and C("courzieu.calendriers.test").post("/api/admin/login", json={"identifiant": "secours", "password": "motdepasse2"}).status_code == 200,
          "admin central : compte de secours dans une caserne")
    # tâches de fond : une sauvegarde par caserne, dans son dossier
    for cas in main._each_caserne():
        with plateforme.use(cas):
            asyncio.run(main._daily_tasks())
    check(all(os.listdir(os.path.join(TMP, "casernes", s, "db", "sauvegardes")) for s in ("courzieu", "vaugneray")), "sauvegarde quotidienne faite pour chaque caserne")
    jr = central.get("/api/plateforme/journal").json()["entrees"]
    check(any(x["action"] == "caserne.creation" for x in jr) and any(x["action"] == "communes.generation" for x in jr), "journal de la plateforme")
print("ÉCHECS :", fails)
sys.exit(1 if fails else 0)
