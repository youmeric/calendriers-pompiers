"""Préparation commune aux tests API : base SQLite temporaire, commune de test, mot de passe admin.
À importer avant l'application (les tests sont indépendants les uns des autres)."""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TEST_DIR = os.environ.get("TEST_DIR") or tempfile.mkdtemp(prefix="calendriers-tests-")
DATA = os.path.join(TEST_DIR, "sectors")
if not os.path.exists(os.path.join(DATA, "courzieu.json")):
    subprocess.run([sys.executable, os.path.join(HERE, "fake_data.py"), DATA], check=True)
os.environ["DB_PATH"] = tempfile.mktemp(dir=TEST_DIR, suffix=".db")
os.environ["SECTORS_DATA_DIR"] = DATA
os.environ["ADMIN_PASSWORD"] = "secret123"
os.environ["AUTO_BACKUP"] = "0"
sys.path.insert(0, ROOT)
