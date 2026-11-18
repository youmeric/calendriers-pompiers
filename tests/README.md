# Tests

Ils tournent sur une **commune de test synthétique** (`fake_data.py` : 144 maisons en grille,
4 secteurs proposés) et une base SQLite temporaire : jamais sur la vraie base, et sans accès
à la Base Adresse ni à OpenStreetMap.

```bash
pip install -r backend/requirements.txt httpx   # tests API
npm install -g playwright                       # tests navigateur (Chromium)
sh tests/run_tests.sh                           # tout
sh tests/run_tests.sh api                       # seulement les tests API
sh tests/run_tests.sh ui_correction             # un seul test
```

| Test | Ce qu'il vérifie |
| --- | --- |
| `api_secteurs_test.py`, `ui_secteurs.js` | secteurs modifiés en pleine tournée : l'historique suit la maison, dons de l'ancienne équipe visibles, avertissement admin, gestes hors réseau acceptés |
| `api_avancement_test.py`, `ui_avancement.js` | réglage du pourcentage d'avancement et pourcentage provisoire en transparence |
| `api_correction_test.py`, `ui_correction.js` | correction d'une adresse fausse (numéro, rue, position), retour à l'origine |

Les journaux et captures d'écran sont dans le dossier temporaire indiqué à la fin.
