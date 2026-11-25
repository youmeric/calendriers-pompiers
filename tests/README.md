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
| `api_entreprises_test.py`, `ui_entreprises.js` | tournée des entreprises : marquer / renommer / retirer, ajout sur la carte, signalement par une équipe, retour au secteur |

| `api_multi_test.py`, `ui_multi_plateforme.js` | plateforme Almaneo : casernes cloisonnées, admin central, identité, guide de démarrage, exploitation |
| `api_identite_test.py` | identité de la caserne ; installation simple identique à Courzieu |
| `api_demarrage_test.py`, `api_exploitation_test.py` | guide de démarrage ; comptes de l'admin central, export, suppression |
| `api_bascule_test.py` | bascule de l'installation simple vers la plateforme |
| `api_vitrine_test.py`, `ui_multi_vitrine.js` | site vitrine almaneo.fr et demandes de démo |
| `api_annexes_test.py`, `ui_annexes.js` | dons hors tournée |

`captures_vitrine.js` (pas un test) régénère les captures du site vitrine.

Les journaux et captures d'écran sont dans le dossier temporaire indiqué à la fin.
