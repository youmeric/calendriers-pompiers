# Calendriers des pompiers — Courzieu & Brussieu

Site web pour organiser la distribution des calendriers des sapeurs-pompiers
sur Courzieu et Brussieu (69690).

- **Page admin (`/admin`)**, protégée par mot de passe : vous créez vous-même
  les secteurs, vous les nommez et leur donnez une couleur.
  - **Par hameaux** (le plus simple) : en cliquant une maison, tout son hameau
    entre dans le secteur (et sort de l'autre secteur s'il y était) ; recliquer
    le retire. Un secteur peut ainsi être en plusieurs morceaux, ou avoir une
    enclave (hameau retiré au milieu).
  - **En dessinant** : les tracés **s'aimantent aux routes** OSM et aux bords
    des secteurs voisins.
  - L'outil **alerte** si un hameau est coupé (avec un bouton pour le remettre
    en entier d'un côté), si des adresses ne sont dans aucun secteur, ou si
    deux secteurs se chevauchent. Ces alertes **n'empêchent jamais
    d'enregistrer**.
  - **Exclure une adresse** (cimetière, bâtiment sans habitant…) : clic sur
    l'adresse → « Exclure ». Elle disparaît des comptes et du site public ;
    on peut la réintégrer.
  - Une proposition automatique (4 secteurs équilibrés, bourg à pied depuis la
    mairie) peut servir de point de départ.
  - **Équilibre** : pour chaque secteur, nombre d'adresses, km de routes,
    temps estimé et écart à la moyenne (minutes par porte réglables).
  - **↶ / ↷** (Ctrl+Z / Ctrl+Y) pour annuler ou rétablir, et **versions** :
    chaque enregistrement garde une copie (30 dernières) qu'on peut recharger.
  - **Option « suivi des adresses »** : désactivée par défaut, la page
    publique sert uniquement de plan. Activée, elle ajoute les boutons
    ✓ fait / ⏳ absent / ✕ refus par adresse.
- **Page publique (`/`)**, pensée pour le téléphone : on voit la carte
  entière avec tous les secteurs **des deux communes**, puis on touche **son**
  secteur. La carte
  zoome dessus et **assombrit tout ce qui est en dehors**, pour voir exactement
  où il se termine. On y trouve :
  - **où s'arrête le secteur**, en mots : les routes suivies par la limite
    (dans le sens des aiguilles d'une montre depuis le nord), avec les routes
    qu'elle croise comme repères ;
  - **ce que comprend le secteur** : hameaux, rues, numéros (« Rue X, n° 2 à
    14, côté pair », « en partie » si le reste de la rue est ailleurs) ;
  - un bouton 📍 pour se localiser, un lien **Partager** propre au secteur, et
    un bouton **🖨 Plan** (plan A4 du secteur, à imprimer ou enregistrer en
    PDF). Un plan d'ensemble de la commune est aussi disponible.

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

Si vous activez le suivi des adresses, pensez au début de chaque nouvelle
tournée : « Autres outils » → *Remettre à zéro les statuts*.

La description des limites suit les routes **réellement** collées par le
tracé : dessinez avec l'aimantation activée pour obtenir « suit la D50 sur
1,2 km » plutôt que « à travers champs ».

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
