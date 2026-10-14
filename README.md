# Calendriers Pompiers — Courzieu & Brussieu

Application web pour organiser la distribution des calendriers des
sapeurs-pompiers sur les communes de **Courzieu** et **Brussieu** (69690) :
calcul automatique de 4 secteurs de distribution équilibrés par commune,
carte interactive, et suivi en temps réel (fait / absent / refus) depuis un
mobile pendant la tournée.

## Comment ça marche

1. **Récupération des données** (`data_pipeline/`) :
   - les adresses officielles depuis la **Base Adresse Nationale (BAN)** ;
   - le réseau routier, les bâtiments et l'emplacement de la mairie depuis
     **OpenStreetMap** (API Overpass) ;
   - le code INSEE et le contour de chaque commune depuis
     `geo.api.gouv.fr`.
2. **Sectorisation** (`data_pipeline/sectorize.py`) :
   - les adresses sont regroupées en unités atomiques — un hameau/lieu-dit,
     ou une rue pour le centre-bourg — **jamais coupées** entre deux
     secteurs ;
   - les distances sont calculées **le long du réseau routier réel** (graphe
     construit à partir d'OSM, plus court chemin de Dijkstra), pas à vol
     d'oiseau ;
   - le **Secteur 1 "Le Bourg"** regroupe toutes les unités accessibles à
     pied depuis la mairie (rayon configurable, 700 m par défaut) ;
   - les hameaux restants sont répartis en **3 secteurs motorisés**
     géographiquement contigus (balayage angulaire autour de la mairie),
     en cherchant la répartition qui **équilibre le temps de distribution
     estimé** (nombre d'adresses × temps au porte-à-porte + temps de trajet
     estimé entre hameaux).
3. **Backend** (`backend/`, FastAPI) : sert les secteurs/adresses en JSON et
   enregistre le statut de chaque adresse (fait / absent / refus) dans une
   base SQLite persistante.
4. **Frontend** (`frontend/`) : carte Leaflet (fond OpenStreetMap), secteurs
   colorés et nommés, liste des adresses par secteur, boutons de statut
   pensés pour l'usage au doigt sur mobile, avec file d'attente hors-ligne
   si le réseau mobile est mauvais sur le terrain.

### Limite connue : le tracé des polygones de secteur

Les limites de secteurs affichées sur la carte sont l'**enveloppe** des
adresses/hameaux qui composent chaque secteur (calculée à partir des points
réels), ce qui leur donne un contour qui suit globalement les zones
habitées et les routes qui les relient. Ce n'est pas un détourage
cadastral exact rue par rue. **Le polygone est une aide visuelle : la
source de vérité est la liste d'adresses de chaque secteur**, dans laquelle
un hameau n'est jamais scindé.

## Démarrage

### 1. Générer les données des secteurs (une fois, puis à chaque nouvelle
   campagne de calendriers)

```bash
docker compose run --rm pipeline
```

Ceci télécharge les adresses BAN et les données OSM pour Courzieu et
Brussieu, calcule les 4 secteurs de chaque commune, et écrit le résultat
dans le volume partagé `sectors-data` (consommé ensuite par le backend).

> Le téléchargement interroge `adresse.data.gouv.fr`, `geo.api.gouv.fr` et
> `overpass-api.de` : il faut que la machine qui exécute cette commande ait
> un accès Internet sortant normal (c'est le cas d'un serveur Debian
> classique). Si le téléchargement BAN échoue avec une erreur 404, le
> chemin d'export de la BAN a probablement changé depuis la rédaction de ce
> script — vérifier l'URL actuelle sur https://adresse.data.gouv.fr et
> mettre à jour `BAN_CSV_URL_CANDIDATES` dans
> `data_pipeline/fetch_ban.py`.

### 2. Démarrer l'application

```bash
docker compose up -d backend
```

L'application est alors disponible sur `http://<votre-serveur>:8000`.

### Mettre à jour les données (nouvelle année)

```bash
docker compose run --rm pipeline --no-cache
docker compose restart backend
```

`--no-cache` force le re-téléchargement complet (sinon les données sources
BAN/OSM déjà téléchargées sont réutilisées). Le statut déjà saisi
(fait/absent/refus) est conservé dans la base SQLite tant qu'on ne la vide
pas ; pour repartir à zéro en début de nouvelle tournée, appeler
`POST /api/communes/<slug>/reset`.

## Développement local (sans Docker)

```bash
cd data_pipeline && pip install -r requirements.txt && python run_pipeline.py
cd ../backend && pip install -r requirements.txt
uvicorn app.main:app --reload --app-dir backend
```

Puis ouvrir `http://localhost:8000`.

## Paramètres ajustables

Tout se trouve en tête de `data_pipeline/sectorize.py` :

- `WALK_RADIUS_M` : rayon (mètres, le long des routes) pour qu'une unité
  soit incluse dans le secteur "Bourg" à pied (défaut 700 m).
- `HANDLING_MIN_PER_ADDRESS` : temps estimé par porte (défaut 1,5 min).
- `WALK_SPEED_KMH` / `DRIVE_SPEED_KMH` : vitesses utilisées pour estimer le
  temps de trajet à pied / en voiture.

Les communes à traiter sont listées dans `data_pipeline/run_pipeline.py`
(`COMMUNES`), pour ajouter facilement une commune supplémentaire plus tard.

## Architecture des dossiers

```
data_pipeline/   scripts Python : récupération BAN/OSM + calcul des secteurs
backend/         API FastAPI (sert les données + enregistre les statuts)
frontend/        page web (Leaflet + JS natif, pas de build nécessaire)
docker-compose.yml
```
