# Almaneo — version multi-casernes, plan de travail

**Almaneo** (de l'*almanach*, le nom historique du calendrier des pompiers) : nom retenu pour la
plateforme, domaine `almaneo.fr` libre au moment du choix (à réserver, avec si possible `almaneo.com`,
et à vérifier / déposer à l'INPI, classes 9 et 42).

Adresses prévues : `admin.almaneo.fr` (admin central), `<caserne>.almaneo.fr` pour chaque caserne
(`courzieu.almaneo.fr`) ; une caserne peut garder en plus son propre domaine (`spcourzieu.fr` mène aussi
à Courzieu : adresse ajoutée à la caserne dans l'admin central). Sur les sites des casernes, mention
discrète « propulsé par Almaneo » (connexion, espace équipe, site public) et un paragraphe dans les
mentions légales ; jamais dans l'installation simple (`PLATFORM_NAME` pour changer le nom).

> Branche `multi-casernes`, **non déployée**. Le site de Courzieu tourne sur `main`.
> Toute modification de `main` est fusionnée ici (`git merge main`) puis adaptée.

## Objectif

Proposer le site à plusieurs casernes :

- **Admin central** (le propriétaire de la plateforme) : créer une caserne, ses communes, son premier
  compte administrateur ; suspendre, archiver, voir l'activité et les sauvegardes de chaque caserne.
- **Chaque caserne** se débrouille ensuite seule, exactement comme Courzieu en 2026 : secteurs, équipes,
  codes d'accès, suivi, dons, caisse, dossier comptable… avec **son nom, son logo, ses couleurs**,
  ses mentions légales, son bot WhatsApp et son compte SumUp.

## Principes retenus (proposition)

1. **Une base de données par caserne** (un fichier SQLite chacune) + une petite base « plateforme »
   (liste des casernes, comptes de l'admin central).
   - Cloisonnement total : aucune requête ne peut mélanger les données de deux casernes.
   - Sauvegarde, export, restauration ou suppression d'une caserne = un fichier.
   - Le code actuel (qui parle à « la » base) change très peu : la base est choisie au début de chaque
     requête selon la caserne.
2. **Une adresse par caserne**, sous-domaine : `courzieu.<domaine>`, `vaugneray.<domaine>`…
   (+ possibilité d'un nom de domaine propre à une caserne).
   - Le site appelle déjà ses API par des chemins absolus (`/api/...`) : rien à réécrire côté pages.
   - Les cookies (admin, équipes) restent naturellement séparés d'une caserne à l'autre.
   - Il faut un DNS « joker » (`*.<domaine>`) et un certificat joker dans Nginx Proxy Manager.
   - L'admin central vit sur `admin.<domaine>` (ou `<domaine>/plateforme`).
3. **Données des communes** (adresses BAN, routes OSM) : générées par le pipeline actuel, lancé
   depuis l'admin central à la création de la caserne (codes INSEE des communes), rangées dans le
   dossier de la caserne.
4. **Personnalisation** : tout ce qui est écrit « Courzieu » en dur dans les pages (titre, écusson,
   « Sapeurs-pompiers de Courzieu »…) vient d'une configuration de la caserne, servie par l'API et
   modifiable dans son admin (logo envoyé en image, nom, couleur principale).
5. **Migration de Courzieu** : la base actuelle devient telle quelle la première caserne de la
   plateforme (aucune donnée perdue, mêmes codes d'accès).

## Avancement

- [x] **Étape 1 — Socle « caserne »** : base plateforme (`backend/app/plateforme.py`), caserne choisie
  d'après l'adresse (sous-domaine `<identifiant>.<domaine>` ou adresse enregistrée), base / données /
  sauvegardes / sessions séparées par caserne, tâches de fond pour chaque caserne. Sans
  `PLATFORM_DB_PATH`, rien ne change (installation actuelle).
- [x] **Admin central, première version** (`backend/app/central.py`, page `/plateforme`) : créer une
  caserne (nom, identifiant, adresses, premier compte administrateur, communes), télécharger les
  communes (pipeline), suspendre / réactiver / archiver, compte administrateur de secours, journal.
- [x] **Option abonnement** préparée : formule (gratuit, essai, actif, expiré) et date de fin par
  caserne, activable dans les réglages de la plateforme ; une caserne expirée voit un avertissement dans
  son admin (rien n'est bloqué pour l'instant — à décider).
- [x] **Étape 2 — Personnalisation** : plus aucun « Courzieu » en dur dans les pages. Chaque caserne
  règle dans son admin (Suivi & dons → Réglages → *Identité de la caserne*) son **nom affiché**, sa
  **couleur principale** et son **logo** (PNG, JPEG, WebP ou SVG, 1 Mo ; gardé dans sa base, donc dans
  ses sauvegardes ; SVG servi sans aucun script possible). Le serveur remplit les pages (`__CASERNE__`,
  `__LOGO__`, `__COMMUNES__`, icônes) et `window.CASERNE` ; l'appli installable (manifest) et le message
  WhatsApp d'accès (`{caserne}`) suivent. Une nouvelle caserne démarre avec son nom et un logo neutre
  (`img/logo-generique.svg`). **Sans réglage, l'installation simple reste exactement celle de Courzieu**
  (nom, écusson, icônes, couleurs) — vérifié par `tests/api_identite_test.py`.
- [x] **Étape 4 — Guide de démarrage** (`frontend/js/demarrage.js`, API `/api/admin/demarrage`) : à la
  première connexion d'une nouvelle caserne, une fenêtre en 4 étapes — *Votre caserne* (nom, couleur,
  logo), *Association et contact* (reçus, mentions, dossier comptable), *Communes et secteurs* (état du
  téléchargement, création des secteurs proposés automatiquement dans chaque commune qui n'en a pas),
  *Lancer la tournée* (année, suivi, dons, étapes suivantes). Chaque étape cochée quand elle est faite ;
  le guide reste accessible par « 🚀 Guide de démarrage » ; jamais affiché dans l'installation simple.
- [x] **Étape 5 — Exploitation** : comptes nominatifs de l'admin central (le mot de passe de
  l'installation reste le compte principal de secours ; changer un mot de passe ou désactiver un compte
  coupe ses sessions ; le journal dit qui a fait quoi) ; **export complet** d'une caserne en un zip (copie
  cohérente de sa base avec logo et réglages, ses communes, `caserne.json`, notice) ; **suppression
  définitive** seulement d'une caserne archivée, en retapant son identifiant ; date de la dernière
  sauvegarde de chaque caserne. Limites déjà en place : logo 1 Mo, 20 communes par téléchargement.
- [x] **Étape 6 — Bascule et mise en service (préparée)** : script `python -m app.basculer` (essai avec
  `--essai`) qui fait de l'installation actuelle une caserne de la plateforme — copie cohérente de la base
  (jamais modifiée : retour arrière immédiat), communes, sauvegardes, écusson, nom ; compte nominatif à la
  place du compte principal ; **mêmes codes, téléphones et comptes toujours connectés** (chaque caserne
  signe ses sessions avec la clé gardée dans sa base). Guide pas à pas : **`docs/MISE-EN-SERVICE.md`**
  (DNS, certificat joker, Nginx Proxy Manager, jour J, vérifications, retour arrière).
  Testé par `tests/api_bascule_test.py`.
- [x] **Site vitrine** (`frontend/vitrine.html`, `css/vitrine.css`) sur `almaneo.fr` et `www.almaneo.fr` :
  présentation, 8 fonctions, captures de l'appli (caserne fictive « Valmont », régénérables avec
  `tests/captures_vitrine.js`), « Comment ça marche », questions, formulaire **« Demander une démo »**
  (champ piège anti-robots, 5 demandes / heure / adresse) dont les demandes arrivent dans l'admin central.
- [x] **Mise en service en deux temps** (décidé : pas de bascule de Courzieu pendant la tournée) :
  Almaneo tourne dès maintenant comme **deuxième installation** sur le serveur (dossier `almaneo`, branche
  `multi-casernes`, conteneur `almaneo` : `CONTAINER_NAME` / `IMAGE_NAME` / `HOST_PORT` réglables), Courzieu
  reste sur `main` ; **en fin de saison**, bascule de Courzieu dans Almaneo et spcourzieu.fr pointé vers
  `almaneo`. Guide : `docs/MISE-EN-SERVICE.md` (parties A et B). Contrôle de santé : `/api/sante`.

### Essayer en local

```bash
PLATFORM_DB_PATH=/tmp/pf/plateforme.db PLATFORM_DOMAIN=localhost PLATFORM_ADMIN_PASSWORD=secret \
  python3 -m uvicorn backend.app.main:app --port 8000
```

Admin central : http://127.0.0.1:8000/plateforme — une caserne « vaugneray » :
http://vaugneray.localhost:8000/admin (les navigateurs résolvent `*.localhost` tout seuls).
Tests : `tests/api_multi_test.py` et `tests/ui_multi_plateforme.js` (lancés par `sh tests/run_tests.sh`).

## Étapes

| # | Étape | Contenu |
|---|-------|---------|
| 1 | Socle « caserne » | Base plateforme, choix de la caserne par le nom d'hôte, base et dossier de données par caserne, caches et tâches de fond (sauvegardes, nettoyage RGPD, copie externe) pour chaque caserne. Mode « une seule caserne » conservé (comportement actuel) tant qu'aucune n'est créée. |
| 2 | Personnalisation | Nom, logo, couleurs, textes ; suppression de tout « Courzieu » en dur ; favicon et icône d'appli par caserne. |
| 3 | Admin central | Comptes de l'admin central, création / suspension / archivage d'une caserne, choix des communes (INSEE), lancement du pipeline, création du premier compte admin de la caserne, vue d'ensemble. |
| 4 | Mise en route d'une caserne | Assistant de démarrage dans l'admin de la caserne (logo, nom, mentions, communes, premiers secteurs proposés automatiquement). |
| 5 | Exploitation | Sauvegardes par caserne, export complet (pour une caserne qui part), journal de l'admin central, limites (taille du logo, nombre de communes). |
| 6 | Migration et mise en service | Script de bascule de l'installation de Courzieu, guide DNS / Nginx Proxy Manager, tests sur deux casernes. |

Chaque étape est testée sur au moins deux casernes de test (les tests actuels de `tests/` doivent
continuer à passer pour une caserne seule).

## Décisions et questions ouvertes

- Hébergement : sur le serveur actuel (décidé).
- Nom : **Almaneo** ; domaine `almaneo.fr` (à acheter, puis `PLATFORM_DOMAIN=almaneo.fr`).
- Abonnement : option préparée, désactivée ; que faire d'une caserne expirée (simple avertissement,
  lecture seule, blocage) reste à décider.
