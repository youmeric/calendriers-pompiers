# Calendriers des pompiers — Courzieu & Brussieu

Site web pour organiser la distribution des calendriers des sapeurs-pompiers
sur Courzieu et Brussieu (69690).

- **Page admin (`/admin`)**, protégée par mot de passe : vous dessinez
  vous-même les secteurs sur la carte, vous les nommez et leur donnez une
  couleur. Les tracés **s'aimantent aux routes** OSM et aux bords des secteurs
  voisins. L'outil vous **alerte** si un hameau est coupé entre deux secteurs,
  si des adresses ne sont dans aucun secteur, ou si deux secteurs se
  chevauchent. Une proposition automatique (4 secteurs équilibrés, bourg à
  pied depuis la mairie) peut servir de point de départ.
- **Page publique (`/`)**, pensée pour le téléphone : on voit la carte
  entière avec tous les secteurs, puis on touche **son** secteur. La carte
  zoome dessus et **assombrit tout ce qui est en dehors**, pour voir exactement
  où il se termine. On y trouve aussi un bouton 📍 pour se localiser, la
  liste des adresses du secteur, et des boutons ✓ fait / ⏳ absent / ✕ refus
  pour chaque adresse (avec mise en attente si le réseau ne passe pas). Chaque
  secteur a son propre lien (bouton **Partager**), qu'on peut envoyer à chaque
  équipe.

## Sources de données

Le pipeline (`data_pipeline/`) récupère :
- les **adresses** officielles dans la Base Adresse Nationale (export CSV du
  département, filtré sur chaque commune) ;
- le **réseau routier**, les **bâtiments** et la **mairie** dans
  OpenStreetMap (API Overpass) ;
- le code INSEE et le **contour** de chaque commune sur `geo.api.gouv.fr`.

Il regroupe aussi les adresses en **groupes d'habitations** (bourg, hameaux,
fermes isolées : deux maisons à moins de 80 m font partie du même groupe).
C'est ce qui permet à la page admin de détecter un hameau coupé.

## Installation sur le serveur Debian (avec Nginx Proxy Manager)

```bash
git clone https://github.com/youmeric/calendriers-pompiers
cd calendriers-pompiers
cp .env.example .env
nano .env        # ADMIN_PASSWORD, PROXY_NETWORK
```

**Réseau de Nginx Proxy Manager** : le site rejoint le réseau Docker de NPM
(déclaré `external` dans `docker-compose.yml`). Pour connaître son nom :

```bash
docker network ls
# ou, depuis le conteneur NPM :
docker inspect <conteneur-npm> -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

Mettez ce nom dans `PROXY_NETWORK` du fichier `.env`. Si vous n'avez pas encore
de réseau partagé, créez-en un et branchez-y NPM :

```bash
docker network create proxy
docker network connect proxy <conteneur-npm>
```

Ensuite :

```bash
docker compose run --rm --build pipeline   # télécharge adresses, routes, bâtiments
docker compose up -d --build backend
```

Dans **Nginx Proxy Manager**, ajoutez un *Proxy Host* :
- Forward Hostname / IP : `calendriers-pompiers`
- Forward Port : `8000`
- onglet SSL : certificat Let's Encrypt + *Force SSL*

Le HTTPS est nécessaire : sans lui, la connexion admin ne fonctionne pas
(cookie sécurisé, voir `COOKIE_SECURE`), et les téléphones refusent la
localisation 📍 et le bouton Partager.

Le port `8000` n'est publié que sur `127.0.0.1` du serveur (accès local ou
tunnel SSH), jamais directement sur Internet.

## Utilisation

1. Ouvrez `https://<votre-domaine>/admin` et connectez-vous avec
   `ADMIN_PASSWORD`.
2. Choisissez la commune, puis dessinez les secteurs (« Dessiner un
   secteur » : cliquez point par point, puis sur le premier point pour
   fermer). Vous pouvez aussi partir de la proposition automatique (« Autres
   outils »).
3. Nommez chaque secteur, choisissez sa couleur, corrigez jusqu'à ce que les
   alertes disparaissent, puis cliquez **Enregistrer**. C'est publié
   immédiatement sur la page publique.
4. Envoyez à chaque équipe le lien de son secteur (page publique → secteur →
   **Partager**).

Au début d'une nouvelle tournée : « Autres outils » → *Remettre à zéro les
statuts*.

## Mises à jour

Après un `git pull`, **reconstruisez toujours les images** (sinon Docker
réutilise l'ancienne version du code) :

```bash
git pull
docker compose up -d --build backend
```

Pour rafraîchir les adresses et les routes (nouvelle année) :

```bash
docker compose run --rm --build pipeline --no-cache
docker compose restart backend
```

Les secteurs dessinés sont conservés. Les nouvelles adresses y sont
automatiquement rattachées, et la page admin signale celles qui tombent hors
secteur.

## Sauvegarde

Tout l'état du site se trouve dans `./data/db/status.db` (secteurs et statuts).
Une copie de ce fichier suffit.

## Développement local

```bash
pip install -r data_pipeline/requirements.txt -r backend/requirements.txt
python data_pipeline/run_pipeline.py
ADMIN_PASSWORD=test COOKIE_SECURE=false uvicorn backend.app.main:app --reload
```

Puis ouvrir `http://localhost:8000` et `http://localhost:8000/admin`.

## Organisation du code

```
data_pipeline/   récupération BAN / OSM, groupes d'habitations, proposition auto
backend/         API FastAPI : secteurs (SQLite), statuts, connexion admin
frontend/        index.html (public) + admin.html, Leaflet et Leaflet-Geoman intégrés
docker-compose.yml
```
