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
  - **🛣 Recaler toutes les limites sur les routes** : redécoupe la commune en
    îlots délimités par les routes et la limite communale, et redessine chaque
    secteur avec ses îlots ; aucune maison ne change de secteur, et toute la
    commune se retrouve couverte (↶ pour annuler).
  - **✂ Couper** un secteur par une ligne (aimantée aux routes) et
    **fusionner** deux secteurs.
  - Les secteurs de **l'autre commune** sont affichés en pointillé (et
    aimantables) pour bien caler les limites à la frontière.
  - Une proposition automatique (4 secteurs équilibrés, bourg à pied depuis la
    mairie) peut servir de point de départ.
  - **Équilibre** : pour chaque secteur, nombre d'adresses, km de routes,
    temps estimé et écart à la moyenne (minutes par porte réglables).
  - **↶ / ↷** (Ctrl+Z / Ctrl+Y) pour annuler ou rétablir, et **versions** :
    chaque enregistrement garde une copie (30 dernières) qu'on peut recharger.
  - **Suivi des maisons et dons** : désactivés par défaut (le site sert
    uniquement de plan) ; voir « Suivi & dons » plus bas.
  - **Année de la tournée** : affichée dans le titre du site et sur les plans
    (« Tournée des calendriers 2027 »). Par défaut, l'année qui suit à partir
    de juillet ; à changer dans « Page publique » si besoin.
- **Aux couleurs de la caserne** : l'écusson des sapeurs-pompiers de Courzieu
  apparaît dans l'en-tête, sur la connexion admin, sur les plans imprimés et
  comme icône de l'application. Pour le remplacer, changer
  `frontend/img/logo-courzieu.png` (et les icônes de `frontend/icons/`).
- **Suivi & dons (admin, onglet « Suivi & dons »)** — tout est optionnel :
  - **Accès protégé** : chaque personne de l'onglet Équipes a un **code
    personnel** (bouton 🔑 : code, lien à envoyer par WhatsApp ou SMS, « changer
    le code » pour couper un accès). Sur son téléphone, elle ouvre le lien
    (`/equipe#acces=CODE`, ou saisit le code dans « Espace équipe ») et arrive
    dans l'**espace équipe** (voir plus bas), limité à **ses secteurs**. Sans
    code, personne ne voit les statuts ni les montants.
    10 codes faux d'affilée bloquent les essais pendant 10 minutes.
  - **📲 Envoyer les accès en masse** (onglet Équipes) : on coche les personnes
    (tous, jamais envoyé, responsables, l'équipe d'un secteur, ou à la main),
    on ajuste le message (`{prenom}`, `{code}`, `{lien}`, `{secteurs}`…, avec
    l'aperçu façon WhatsApp) et le site envoie chaque message **directement
    par le bot WhatsApp** (wppconnect, son `POST /send`), sans passer par n8n
    ni par le site de programmation. Un message toutes les 2 à 3 secondes,
    progression et ✓/✕ par personne ; l'envoi s'arrête de lui-même si le bot
    est déconnecté. La date du dernier envoi est gardée (📲 dans la liste) et
    s'efface quand on change le code. Réglage une fois pour toutes dans la même
    fenêtre → *Bot WhatsApp* : l'adresse du bot **vue depuis le serveur du
    site** (ex. `http://192.168.1.20:3000`, ou `http://host.docker.internal:3000`
    si le bot tourne sur la même machine) et, si le bot en demande une, une clé
    envoyée dans l'en-tête `X-API-Key`.
  - **Suivi des maisons** : ✓ fait / ⏳ absent / ✕ refus, partagé en direct
    entre les membres de l'équipe (actualisé chaque minute), fonctionne sans
    réseau (envoi au retour du réseau).
  - **Dons** : bouton € sur chaque maison, montant (raccourcis 5/10/15/20/30 €),
    espèces, chèque ou carte ; la maison passe « faite ». Chaque don garde qui
    l'a saisi. Les équipiers ne voient que leurs propres montants ; le
    **responsable du secteur** et l'admin voient tout et les totaux.
  - **Carte avec SumUp** (« Payment Switch » de SumUp) : « Payer par carte avec
    SumUp » ouvre l'appli SumUp avec le montant ; après le paiement, SumUp revient
    sur `/sumup-retour/…` qui valide le don (accepté / refusé). Il faut l'appli
    SumUp installée et connectée sur le téléphone, et une **clé d'affiliation**
    (me.sumup.com → Développeurs) à coller dans les réglages avec l'identifiant
    d'application associé. SumUp présente cette méthode comme ancienne (plus
    développée) mais toujours disponible ; sur iPhone, elle marche depuis Safari
    (pas toujours depuis l'appli installée sur l'écran d'accueil). Solution de
    secours toujours possible : encaisser dans l'appli SumUp puis « saisir à la
    main » (montant + n° de transaction). Les paiements restés sans réponse
    apparaissent « en attente » : le responsable ou l'admin les valide ou les
    annule.
  - **Bilan** : maisons faites, dons et totaux (espèces / chèques / carte) par
    secteur et au total, export de tous les dons (Excel). Les dons sont classés
    par année de tournée.
  - **🖨 Bilan de l'année** (`/bilan.html`, pour l'assemblée générale) : une page
    A4 à imprimer ou enregistrer en PDF, avec les chiffres clés (total, maisons
    faites, don moyen, moyenne par maison, absents et refus) **comparés à
    l'année précédente**, la répartition espèces / chèques / carte, un
    graphique des dons par secteur (cette année et l'an dernier), le détail
    par secteur avec les responsables, et la caisse. On choisit l'année en
    haut. Les données de l'an dernier sont rangées dans les secteurs actuels
    pour comparer à surface égale.
  - **Avancement en direct** : carte des secteurs colorés selon le pourcentage
    de maisons faites (gris → orange → vert), avec le total des dons ;
    actualisée toutes les 30 secondes.
  - **Remise de la caisse** : le responsable du secteur déclare dans son appli
    les espèces et chèques comptés et à qui il les remet ; le site les compare
    aux dons saisis et signale l'écart. L'admin (trésorier) confirme la
    réception ; la colonne « À remettre » montre ce qui reste dehors.
  - **Mémoire de l'an dernier** : le suivi est rangé par année ; sur chaque
    maison, l'équipe voit ce qui s'est passé à la tournée précédente
    (« 2026 : absent », « refus », « don de 15 € » — le montant seulement pour
    le responsable). Changer l'année dans les réglages démarre une nouvelle
    tournée sans rien effacer.
- **Espace équipe (`/equipe`)**, l'appli des équipes sur le terrain, avec 5
  onglets en bas de l'écran :
  - **Accueil** : dès la connexion, le **bilan de son secteur** : date,
    créneau et consignes, anneau d'avancement (maisons passées / total), à
    faire · faites · absents · refus (un appui ouvre la liste filtrée), dons
    (total du secteur et caisse à remettre pour le responsable, ses propres
    dons pour un équipier) et le bilan de la tournée de l'an dernier ;
  - **Carte** : le secteur seul, les maisons colorées selon leur statut, 📍 ma
    position ; toucher une maison ouvre sa fiche (statut, don, « Y aller ») ;
  - **Maisons** : liste par hameau / rue, filtres À faire · Absents · Faits ·
    Refus · Toutes, recherche, boutons ✓ ⏳ ✕ € sur chaque ligne ;
  - **Caisse** (si les dons sont activés) : totaux, paiements carte en
    attente, remise de la caisse (responsable) ou ses dons (équipier) ;
  - **Équipe** : les membres avec boutons appeler / SMS, l'avancement du
    secteur (à faire / en cours / terminé, réglé par le responsable), le plan
    à imprimer, changer de secteur, se déconnecter.
  - **Changement d'équipe le jour J** : le responsable peut **ajouter un
    équipier** (une personne de la caserne, avec « déjà prévu sur C3 le même
    jour » signalé, ou une nouvelle personne : nom et téléphone) et **retirer
    un équipier absent** (✕). L'équipier ajouté se connecte avec son propre
    code ; une nouvelle personne reçoit le sien de l'admin (onglet Équipes →
    🔑). Les responsables, eux, restent gérés par l'admin. Tout est visible
    aussitôt dans l'onglet Équipes de l'admin.
  - **▶ Commencer la tournée** (mode « maison suivante ») : une maison à la
    fois en grand, la plus proche de sa position GPS (sinon de la dernière
    maison passée), avec trois gros boutons Fait / Absent / Refus, « € Don »,
    « 🧭 Y aller » et « ⏭ Passer ». Chaque action passe à la maison suivante.
  - Après chaque marquage, un bandeau **« Annuler »** reste 5 secondes pour
    corriger une erreur de doigt.
  - **Sans réseau** (hameaux mal couverts) : le secteur, ses maisons, les
    notes, les dons et l'équipe sont gardés sur le téléphone. L'appli s'ouvre
    et fonctionne même en zone blanche (bandeau « 📴 Hors connexion ») :
    statuts, dons en espèces ou chèque, notes et signalements sont gardés et
    **envoyés tout seuls au retour du réseau** (un don n'est jamais compté deux
    fois). Seuls SumUp et la remise de caisse demandent le réseau. Onglet
    Équipe → **« Préparer la carte »** (en Wi-Fi, avant de partir) télécharge
    le plan IGN du secteur pour avoir aussi le fond de carte sans réseau.
  - **Notes par maison** (fiche de la maison) : « chien », « ne pas sonner »,
    « repasser le soir »… avec des raccourcis. Elles sont **gardées d'une
    année sur l'autre**, visibles seulement par l'équipe du secteur (et
    l'admin), affichées dans la liste et en grand en mode tournée.
  - **Signaler un problème d'adresse** : depuis la fiche (« maison vide,
    démolie ou pas une habitation », « numéro ou rue faux », autre), ou
    **« + 🏠 » sur la carte** pour placer une maison qui manque dans la liste.
    L'admin les retrouve dans « Suivi & dons » → *Signalements du terrain*
    (et sur la carte en direct) : **« Ajouter la maison »** (elle entre dans
    le secteur, avec son hameau) ou **« Exclure l'adresse »** corrigent
    aussitôt les secteurs et les comptes.
  - L'appli installée sur l'écran d'accueil ouvre directement l'espace
    équipe pour une personne connectée ; dans le navigateur, le plan public
    garde un bouton « Mon espace équipe ».
- **Équipes (admin, onglet « Équipes »)** : qui fait quel secteur.
  - **Personnes** : la liste des membres de la caserne (nom, téléphone
    facultatif), à saisir un par un ou en collant toute une liste
    (« Nom ; téléphone », une personne par ligne).
  - **Une fiche par secteur** (des deux communes) : **responsable(s)** ★ puis
    **équipiers**, **date** et **créneau** (journée, matin, après-midi, soir),
    **avancement** (à faire / en cours / terminé) et **consignes** (rendez-vous,
    clés, véhicule…). On place les personnes avec « + Ajouter », ou en les
    **glissant** depuis la liste sur ordinateur (on peut aussi glisser une
    personne d'un secteur à l'autre) ; ☆ nomme responsable, × retire.
  - **Alertes** : secteur sans responsable, secteur sans personne, une même
    personne prévue sur deux secteurs le même jour.
  - Tout est **enregistré aussitôt**. **Exporter (Excel)** donne le tableau
    complet ; **Imprimer le tableau** sort le plan d'ensemble avec les équipes.
  - Sur le site public, chaque secteur affiche son équipe (et la liste des
    secteurs montre le responsable, la date et l'avancement) ; on peut
    **chercher son nom** pour trouver son secteur. Les **téléphones ne sont pas
    publiés** sauf si on coche l'option ; ils figurent toujours sur les plans
    imprimés depuis un navigateur connecté à l'admin. Les équipes peuvent aussi
    être masquées complètement du site public.
  - Une équipe reste attachée à son secteur quand on modifie son tracé ; elle
    disparaît si le secteur est supprimé (ou remplacé par « Importer la
    proposition automatique »).
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
  - un bouton 📍 qui dit **dans quel secteur on se trouve** (« Vous êtes dans
    ce secteur, limite à 150 m » / « hors de ce secteur »), un lien
    **Partager** propre au secteur, et un bouton **🖨 Plan** (plan A4 avec
    **QR code**, à imprimer ou enregistrer en PDF). Un plan d'ensemble des deux
    communes est aussi disponible.
  - sur téléphone, la liste est dans une **feuille qu'on glisse** avec la
    petite barre : repliée (carte en plein écran, avec le nom du secteur et
    « ← Secteurs »), mi-hauteur ou plein écran. Un appui sur la barre la
    replie / déplie aussi. La position est mémorisée ;
  - **« Y aller »** : toucher une maison sur la carte (ou un résultat de
    recherche) ouvre une bulle avec un bouton qui lance le GPS (Plans sur
    iPhone, choix des applis sur Android) et des liens Google Maps / Waze ;
  - **« Installer l'application »** : sur téléphone, une carte en haut de la
    liste installe le site sur l'écran d'accueil (Android : en un appui ;
    iPhone : les étapes Partager → « Sur l'écran d'accueil » sont expliquées).
- **Plan à imprimer / télécharger (`plan.html`)** : la liste « Plan » en haut
  choisit **un secteur seul**, **une commune** ou **l'ensemble**. Le bouton
  ⚙ Options règle ce qui est imprimé (choix mémorisés) :
  - autour du secteur : **masqué** (seul le secteur apparaît, par défaut),
    estompé, grisé ou visible ; secteurs voisins affichés ou non ;
  - **points des maisons** oui / non ; limite de commune oui / non ;
  - **détail** : description de la limite, hameaux et rues, liste complète
    des adresses par voie ; pour l'ensemble, tableau des secteurs et
    étiquettes (code et nom, code seul, aucune). Sans détail, la carte prend
    toute la page ;
  - **Carte seule, en pleine page** : ni titre, ni texte, ni tableau, ni
    sources ; uniquement la carte sur toute la feuille (marges de 6 mm), en
    portrait ou en paysage, toujours sur une seule page ;
  - sinon, au choix : en-tête (logo, titre), QR code, sources en bas de page,
    orientation **portrait ou paysage**. Quand rien n'est imprimé sous la carte,
    elle s'agrandit pour remplir la page.
  « ⬇ Télécharger en PDF » ouvre la fenêtre d'impression : choisir
  « Enregistrer au format PDF ».
  - une **recherche** d'adresse, de rue ou de hameau qui ouvre le bon secteur ;
  - des **pastilles** (C1, C2… B1…) qui numérotent les secteurs : vue de loin,
    la carte n'affiche que les pastilles, les noms apparaissent en zoomant ;
  - trois **fonds de carte** : OpenStreetMap, plan IGN, photo aérienne IGN.
  - Le site s'**installe sur l'écran d'accueil** du téléphone comme une
    application (menu du navigateur → « Ajouter à l'écran d'accueil »).

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
   **Partager**) et, si le suivi est activé, à chaque personne son **lien
   personnel** (onglet Équipes → 🔑).

Le suivi des maisons est rangé par année de tournée : une nouvelle année
repart de zéro toute seule (l'an dernier reste visible comme « mémoire »).

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

Tout l'état du site se trouve dans `./data/db/status.db` (secteurs, équipes, réglages, suivi, dons).

Le site en fait **une sauvegarde automatique par jour** dans `./data/db/sauvegardes/`
(30 gardées). Depuis l'admin (onglet « Suivi & dons ») : « Sauvegarder maintenant » et
téléchargement des dernières sauvegardes. Pensez à en garder une copie ailleurs que sur le
serveur (clé USB, cloud). Pour restaurer : arrêter le site, remplacer `status.db` par la
sauvegarde voulue (renommée `status.db`), relancer.

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
backend/         API FastAPI : secteurs (SQLite), équipes, statuts, dons, caisse, connexions
frontend/        index.html (public), equipe.html (appli des équipes), admin.html, plan.html ;
                 Leaflet et Leaflet-Geoman intégrés
docker-compose.yml
```
