"""Site vitrine d'Almaneo (almaneo.fr) : page, demandes de démonstration, adresses."""
import os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="vitrine-")
os.environ.update({"PLATFORM_DB_PATH": f"{TMP}/plateforme.db", "CASERNES_DIR": f"{TMP}/casernes", "PLATFORM_ADMIN_PASSWORD": "central-secret",
                   "PLATFORM_DOMAIN": "almaneo.test", "PLATFORM_CONTACT_EMAIL": "contact@almaneo.test", "AUTO_BACKUP": "0"})
sys.path.insert(0, os.path.dirname(HERE))
from fastapi.testclient import TestClient  # noqa: E402
from backend.app import main  # noqa: E402

fails = 0
def check(c, m):
    global fails
    print(("OK  " if c else "FAIL") + " " + m)
    fails += 0 if c else 1

C = lambda host: TestClient(main.app, base_url=f"http://{host}")  # noqa: E731
v = C("almaneo.test")
with v:
    h = v.get("/").text
    check("La tournée des calendriers" in h and "Almaneo" in h and "Demander une démo" in h and "__" not in h.replace("__V__", ""), "almaneo.fr : le site vitrine")
    check("votrecaserne.almaneo.test" in h and "mailto:contact@almaneo.test" in h, "domaine et contact de la plateforme")
    check(C("www.almaneo.test").get("/").text == h, "www.almaneo.fr : même page")
    check('<link rel="canonical" href="https://almaneo.test/"' in h and '"@type": "SoftwareApplication"' in h, "référencement : adresse canonique et données structurées")
    r = v.get("/robots.txt")
    check(r.status_code == 200 and "Allow: /" in r.text and "Sitemap: https://almaneo.test/sitemap.xml" in r.text, "robots.txt de la vitrine")
    check("<loc>https://almaneo.test/</loc>" in v.get("/sitemap.xml").text, "sitemap.xml")
    check(C("vaugneray.almaneo.test").get("/robots.txt").text.strip().endswith("Disallow: /")
          and C("admin.almaneo.test").get("/robots.txt").text.strip().endswith("Disallow: /"), "espaces des casernes et admin central : pas référencés")
    hd = v.get("/", headers={"X-Forwarded-Proto": "https"}).headers
    check(hd.get("x-content-type-options") == "nosniff" and hd.get("x-frame-options") == "SAMEORIGIN" and "geolocation=(self)" in hd.get("permissions-policy", "")
          and hd.get("strict-transport-security") == "max-age=31536000" and "x-robots-tag" not in hd, "en-têtes de sécurité sur la vitrine")
    check(C("autre.test").get("/plateforme").headers.get("x-robots-tag") == "noindex, nofollow", "admin central : noindex")
    for img in ("/img/vitrine/phone-accueil.jpg", "/img/almaneo/logo.png", "/img/almaneo/favicon-32.png", "/img/almaneo/favicon-48.png", "/img/almaneo/favicon-192.png", "/favicon.ico", "/img/almaneo/partage.png", "/css/vitrine.css", "/js/vitrine.js"):
        check(v.get(img).status_code == 200, f"ressource {img}")
    check(v.get("/api/communes").status_code == 404 and v.get("/admin").status_code == 404, "pas d'outil sur la vitrine")
    r = v.get("/plateforme", follow_redirects=False)
    check(r.status_code in (302, 307) and r.headers["location"] == "https://admin.almaneo.test/plateforme", "/plateforme : renvoie vers admin.almaneo.fr")
    d = {"nom": "Marc Dupuis", "caserne": "Amicale des SP de Vaugneray", "email": "marc@exemple.fr", "telephone": "06 11 22 33 44", "message": "3 communes",
         "commune": "Vaugneray", "equipiers": "25"}
    check(v.post("/api/vitrine/demande", json=d).status_code == 200, "demande de démo envoyée")
    check(v.post("/api/vitrine/demande", json={**d, "email": "pas-un-email"}).status_code == 422, "e-mail invalide refusé")
    check(v.post("/api/vitrine/demande", json={**d, "nom": "Robot", "site": "http://spam"}).status_code == 200, "robot (champ piège rempli) : réponse normale…")
    p = C("admin.almaneo.test")
    p.post("/api/plateforme/login", json={"password": "central-secret"})
    dem = p.get("/api/plateforme/demandes").json()["demandes"]
    check(len(dem) == 1 and dem[0]["caserne"] == "Amicale des SP de Vaugneray" and dem[0]["commune"] == "Vaugneray" and dem[0]["equipiers"] == "25" and not dem[0]["traitee"], "… mais seule la vraie demande arrive dans l'admin central")
    check(v.get("/api/plateforme/demandes").status_code == 404 and C("autre.test").get("/api/plateforme/demandes").status_code == 401, "demandes réservées à l'admin central")
    check(p.put(f"/api/plateforme/demandes/{dem[0]['id']}", json={"traitee": True}).status_code == 200 and p.get("/api/plateforme/demandes").json()["demandes"][0]["traitee"],
          "demande marquée traitée")
    for _ in range(4):
        v.post("/api/vitrine/demande", json=d)
    check(v.post("/api/vitrine/demande", json=d).status_code == 429, "trop de demandes d'une même adresse : freinées")
    check(p.get("/").status_code in (200, 307) and "Almaneo" in p.get("/plateforme").text, "admin.almaneo.fr : l'admin central")
    p.post("/api/plateforme/casernes", json={"slug": "vaugneray", "nom": "SP Vaugneray", "admin_identifiant": "chef", "admin_nom": "Paul", "admin_password": "motdepasse1"})
    check("Demander une démo" not in C("vaugneray.almaneo.test").get("/").text and C("vaugneray.almaneo.test").post("/api/vitrine/demande", json=d).status_code == 404,
          "une caserne garde son site (pas de vitrine)")
print("ÉCHECS :", fails)
sys.exit(1 if fails else 0)
