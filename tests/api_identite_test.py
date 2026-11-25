"""Identité de la caserne, installation simple (Courzieu) : sans réglage, rien ne change ;
nom, couleur et logo personnalisables."""
import base64, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _env  # noqa: E402,F401
from fastapi.testclient import TestClient  # noqa: E402
from backend.app.main import app  # noqa: E402

fails = 0
def check(c, m):
    global fails
    print(("OK  " if c else "FAIL") + " " + m)
    fails += 0 if c else 1

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64).decode()
admin = TestClient(app)
with admin:
    for page in ("/", "/admin", "/equipe", "/plan.html", "/bilan.html", "/fiscal.html", "/mentions"):
        html = admin.get(page).text
        check("__CASERNE__" not in html and "__LOGO__" not in html and "__FAVICON__" not in html and "__APPLEICON__" not in html and "__ICON__" not in html and "__PROPULSE__" not in html and "__PLATEFORME__" not in html, f"{page} : aucun emplacement laissé vide")
    home = admin.get("/").text
    check("Sapeurs-pompiers de Courzieu" in home and "/img/logo-courzieu.png" in home and "/icons/icon-192.png" in home and "/icons/apple-touch-icon.png" in home and "<style>:root" not in home,
          "sans réglage : nom, logo, icône et couleurs de Courzieu, comme avant")
    check("Courzieu &amp; Brussieu" in admin.get("/bilan.html").text, "bilan imprimé : communes de la caserne")
    check("Almaneo" not in home and "Almaneo" not in admin.get("/mentions").text, "installation simple : aucune mention de la plateforme Almaneo")
    m = admin.get("/manifest.webmanifest").json()
    check(m["name"] == "Tournée des calendriers — Sapeurs-pompiers de Courzieu" and m["icons"][0]["src"].startswith("icons/"), "appli installable : nom et icônes de Courzieu")
    admin.post("/api/admin/login", json={"password": "secret123"})
    check(admin.get("/api/admin/demarrage").json()["multi"] is False, "installation simple : pas de guide de démarrage automatique")
    st = admin.get("/api/admin/settings").json()
    check(st["caserne_nom"] == "Sapeurs-pompiers de Courzieu" and st["caserne_couleur"] == "#e5383b" and not st["caserne_logo_perso"], "réglages : identité par défaut")
    admin.put("/api/admin/settings", json={"caserne_nom": "  Pompiers   de Courzieu ", "caserne_couleur": "#1d4ed8"})
    home = admin.get("/").text
    check("Pompiers de Courzieu" in home and "--accent:#1d4ed8" in home and '"couleur": "#1d4ed8"' in home, "nom et couleur personnalisés")
    check(admin.put("/api/admin/settings", json={"caserne_couleur": "rouge"}).status_code == 422, "couleur invalide refusée")
    check(admin.put("/api/admin/logo", json={"type": "image/png", "data": PNG}).status_code == 200, "logo PNG envoyé")
    logo = admin.get("/api/admin/settings").json()["caserne_logo"]
    r = admin.get(logo)
    check(logo.startswith("/logo?v=") and r.status_code == 200 and r.headers["content-type"] == "image/png" and r.content.startswith(b"\x89PNG"), "logo servi par /logo")
    home = admin.get("/").text
    check(logo in home and "/img/logo-courzieu.png" not in home and f'href="{logo}"' in home, "pages, icône : nouveau logo")
    check(admin.get("/manifest.webmanifest").json()["icons"][0]["src"] == logo, "appli installable : nouveau logo")
    check(admin.put("/api/admin/logo", json={"type": "image/jpeg", "data": PNG}).status_code == 422, "type ne correspondant pas au fichier : refusé")
    svg = base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').decode()
    admin.put("/api/admin/logo", json={"type": "image/svg+xml", "data": svg})
    r = admin.get(admin.get("/api/admin/settings").json()["caserne_logo"])
    check("sandbox" in r.headers.get("content-security-policy", "") and r.headers.get("x-content-type-options") == "nosniff", "logo SVG : aucun script ne peut s'exécuter")
    check(TestClient(app).put("/api/admin/logo", json={"type": "image/png", "data": PNG}).status_code == 401, "réservé à l'admin")
    admin.delete("/api/admin/logo")
    check("/img/logo-courzieu.png" in admin.get("/").text, "logo d'origine rétabli")
    jr = admin.get("/api/admin/journal").json()["entrees"]
    check(any(x["objet"] == "logo" for x in jr), "journal : logo")
print("ÉCHECS :", fails)
sys.exit(1 if fails else 0)
