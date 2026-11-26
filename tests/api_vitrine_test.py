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
    check("Votre tournée" in h and "Almaneo" in h and "Demander une démo" in h and "__" not in h.replace("__V__", ""), "almaneo.fr : le site vitrine")
    check("votrecaserne.almaneo.test" in h and "mailto:contact@almaneo.test" in h, "domaine et contact de la plateforme")
    check(C("www.almaneo.test").get("/").text == h, "www.almaneo.fr : même page")
    check('<link rel="canonical" href="https://almaneo.test/"' in h and '"SoftwareApplication"' in h, "référencement : adresse canonique et données structurées")
    r = v.get("/robots.txt")
    check(r.status_code == 200 and "Allow: /" in r.text and "Sitemap: https://almaneo.test/sitemap.xml" in r.text, "robots.txt de la vitrine")
    check("<loc>https://almaneo.test/</loc>" in v.get("/sitemap.xml").text, "sitemap.xml")
    check(C("vaugneray.almaneo.test").get("/robots.txt").text.strip().endswith("Disallow: /")
          and C("admin.almaneo.test").get("/robots.txt").text.strip().endswith("Disallow: /"), "espaces des casernes et admin central : pas référencés")
    hd = v.get("/", headers={"X-Forwarded-Proto": "https"}).headers
    check(hd.get("x-content-type-options") == "nosniff" and hd.get("x-frame-options") == "SAMEORIGIN" and "geolocation=(self)" in hd.get("permissions-policy", "")
          and hd.get("strict-transport-security") == "max-age=31536000" and "x-robots-tag" not in hd, "en-têtes de sécurité sur la vitrine")
    check(C("autre.test").get("/plateforme").headers.get("x-robots-tag") == "noindex, nofollow", "admin central : noindex")
    for img in ("/img/vitrine/phone-accueil.webp", "/img/vitrine/demo-tournee.webp", "/img/vitrine/caserne-1.webp", "/img/almaneo/logo.png", "/img/almaneo/logo-fond-fonce.png", "/img/almaneo/favicon-32.png", "/img/almaneo/favicon-48.png", "/img/almaneo/favicon-192.png", "/favicon.ico", "/img/almaneo/partage.png", "/css/vitrine.css", "/js/vitrine.js"):
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
    # tarifs : cachés au départ, puis affichés depuis l'admin central
    check('id="tarifs"' not in v.get("/").text and "phase pilote" in v.get("/").text and p.get("/api/plateforme/tarifs").json()["actif"] is False,
          "tarifs : cachés tant que l'admin central ne les affiche pas")
    check(v.put("/api/plateforme/tarifs", json={"actif": True}).status_code == 404 and C("autre.test").put("/api/plateforme/tarifs", json={"actif": True}).status_code == 401,
          "tarifs : modifiables seulement par l'admin central")
    check(p.put("/api/plateforme/tarifs", json={"actif": True, "offres": []}).status_code == 400, "tarifs : au moins une formule pour les afficher")
    offres = [{"nom": "Essentiel", "prix": "89 €", "periode": "par an", "accroche": "Une ou deux communes", "inclus": ["Tout", "  ", "Sauvegardes"], "bouton": "Choisir"},
              {"nom": "Amicale <b>", "prix": "149 €", "periode": "par an", "inclus": ["Visio"], "vedette": True}]
    r = p.put("/api/plateforme/tarifs", json={"actif": True, "note": "Paiement par virement.", "offres": offres})
    check(r.status_code == 200 and r.json()["offres"][0]["inclus"] == ["Tout", "Sauvegardes"], "tarifs enregistrés (lignes vides retirées)")
    h2 = v.get("/").text
    check('id="tarifs"' in h2 and 'href="#tarifs">Tarifs</a>' in h2 and "Paiement par virement." in h2 and h2.count('class="v-price-card') == 2
          and "is-featured" in h2 and '<option value="Essentiel">Essentiel — 89 €</option>' in h2 and "phase pilote" not in h2, "vitrine : partie Tarifs, menu, formulaire et FAQ")
    check("Amicale <b>" not in h2 and "Amicale &lt;b&gt;" in h2, "tarifs : texte échappé")
    from backend.app import central as _central
    _central._demandes_ip.clear()
    check(v.post("/api/vitrine/demande", json={**d, "offre": "Essentiel"}).status_code == 200
          and p.get("/api/plateforme/demandes").json()["demandes"][0]["offre"] == "Essentiel", "demande avec la formule choisie")
    p.put("/api/plateforme/tarifs", json={"actif": False, "offres": offres})
    check('id="tarifs"' not in v.get("/").text, "tarifs cachés à nouveau")
    p.post("/api/plateforme/casernes", json={"slug": "vaugneray", "nom": "SP Vaugneray", "admin_identifiant": "chef", "admin_nom": "Paul", "admin_password": "motdepasse1"})
    # pages secondaires : mentions légales, confidentialité, accès à son espace
    ml = v.get("/mentions-legales")
    check(ml.status_code == 200 and "Mentions légales" in ml.text and "OVH SAS" in ml.text and "article 6, III, 2" in ml.text
          and "mailto:contact@almaneo.test" in ml.text and "__" not in ml.text.replace("__V__", ""), "mentions légales (éditeur, hébergeur, contact)")
    cf = v.get("/confidentialite")
    check(cf.status_code == 200 and "3 ans" in cf.text and "aucun cookie" in cf.text and "CNIL" in cf.text, "politique de confidentialité")
    check(C("vaugneray.almaneo.test").get("/mentions-legales").status_code == 404, "pages du site vitrine : seulement sur almaneo.fr")
    a = v.get("/acces", params={"q": "vaug"})
    check(a.status_code == 200 and 'href="https://vaugneray.almaneo.test/"' in a.text and "noindex" in a.text, "accès : la caserne est retrouvée par son nom")
    check("au moins 3 lettres" in v.get("/acces", params={"q": "va"}).text and "Aucune caserne" in v.get("/acces", params={"q": "zzzz"}).text
          and "vaugneray.almaneo.test" not in v.get("/acces", params={"q": "va"}).text, "accès : pas de liste complète, message si rien")
    x = v.get("/acces", params={"q": "<script>alert(1)</script>"}).text
    check("<script>alert" not in x and "&lt;script&gt;" in x, "accès : recherche échappée")
    check('"index, follow"' in v.get("/acces").text and "/mentions-legales</loc>" in v.get("/sitemap.xml").text, "pages déclarées à Google")
    check('href="/mentions-legales"' in v.get("/").text and 'href="/acces"' in v.get("/").text, "liens depuis la page d'accueil")
    from backend.app import plateforme as _pf
    with _pf.conn() as c:
        c.execute("UPDATE demandes SET created_at = '2020-01-01T00:00:00+00:00' WHERE id = (SELECT MIN(id) FROM demandes)")
        c.commit()
    avant = len(p.get("/api/plateforme/demandes").json()["demandes"])
    check(_pf.purge_demandes() == 1 and len(p.get("/api/plateforme/demandes").json()["demandes"]) == avant - 1, "demandes de plus de 3 ans effacées")
    check("Demander une démo" not in C("vaugneray.almaneo.test").get("/").text and C("vaugneray.almaneo.test").post("/api/vitrine/demande", json=d).status_code == 404,
          "une caserne garde son site (pas de vitrine)")
print("ÉCHECS :", fails)
sys.exit(1 if fails else 0)
