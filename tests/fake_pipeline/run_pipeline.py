"""Pipeline factice pour les tests de la version multi-casernes : écrit les communes de test
(fake_data.py) dans SECTORS_OUTPUT_DIR au lieu de télécharger la Base Adresse et OpenStreetMap."""
import os
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
subprocess.run([sys.executable, os.path.join(os.path.dirname(here), "fake_data.py"), os.environ["SECTORS_OUTPUT_DIR"]], check=True)
print("communes de test écrites")
