"""Adresse du visiteur derrière le proxy : les essais de code ratés sont comptés par visiteur,
pas pour toute la commune (sinon 10 fautes de frappe bloqueraient tout le monde)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _env  # noqa: E402,F401
from starlette.requests import Request  # noqa: E402
from backend.app import auth  # noqa: E402

fails = 0
def check(c, m):
    global fails
    print(("OK  " if c else "FAIL") + " " + m)
    fails += 0 if c else 1

def req(peer, xff=None):
    headers = [(b"x-forwarded-for", xff.encode())] if xff else []
    return Request({"type": "http", "method": "POST", "path": "/", "headers": headers, "client": (peer, 1234)})

check(auth.client_ip(req("172.18.0.5", "86.10.20.30")) == "86.10.20.30", "derrière le proxy : l'adresse du visiteur")
check(auth.client_ip(req("172.18.0.5", "1.2.3.4, 86.10.20.30")) == "86.10.20.30", "adresse inventée par le visiteur ignorée : on garde celle ajoutée par le proxy")
check(auth.client_ip(req("172.18.0.5")) == "172.18.0.5", "sans en-tête : l'adresse de connexion")
check(auth.client_ip(req("86.10.20.30", "9.9.9.9")) == "86.10.20.30", "connexion directe depuis Internet : en-tête ignoré")
check(auth.client_ip(req("testclient")) == "testclient", "client de test")

for _ in range(auth.MAX_ATTEMPTS):
    auth.record_failure(auth.client_ip(req("172.18.0.5", "86.10.20.30")))
check(auth.too_many_attempts(auth.client_ip(req("172.18.0.5", "86.10.20.30"))), "le visiteur qui se trompe trop est freiné")
check(not auth.too_many_attempts(auth.client_ip(req("172.18.0.5", "90.1.1.1"))), "les autres visiteurs ne sont pas bloqués")

print("ÉCHECS :", fails) if fails else print("Tous les contrôles passent")
sys.exit(1 if fails else 0)
