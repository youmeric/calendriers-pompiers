# Mise en service d'Almaneo

Deux temps, pour ne jamais gêner la tournée en cours :

- **A. Maintenant** : Almaneo tourne comme une **deuxième installation** sur le même serveur, à côté de
  Courzieu. Elle sert `almaneo.fr` (site vitrine), `admin.almaneo.fr` (admin central) et les futures
  casernes. **L'installation de Courzieu (spcourzieu.fr) ne change pas.**
- **B. En fin de saison** : Courzieu bascule dans Almaneo (mêmes codes, téléphones toujours connectés),
  et spcourzieu.fr pointe vers Almaneo.

Dossiers sur le serveur :

| Dossier | Branche | Conteneur | Sert |
|---|---|---|---|
| `/opt/docker-compose/calendriers-pompiers` | `main` | `calendriers-pompiers` | spcourzieu.fr (aujourd'hui) |
| `/opt/docker-compose/almaneo` | `multi-casernes` | `almaneo` | almaneo.fr, admin.almaneo.fr, *.almaneo.fr |

---

## A. Lancer Almaneo maintenant

### A1. DNS (chez le registraire d'almaneo.fr)

Dans la zone DNS d'`almaneo.fr`, des enregistrements **A** vers l'adresse IP publique du serveur
(la même que spcourzieu.fr) :

| Sous-domaine | Type | Cible | Rôle |
|---|---|---|---|
| *(vide, ou `@`)* | A | IP du serveur | site vitrine almaneo.fr |
| `www` | A | IP du serveur | www.almaneo.fr (même vitrine) |
| `admin` | A | IP du serveur | admin central |
| `*` | A | IP du serveur | toutes les casernes (courzieu.almaneo.fr…) |

(Si le serveur a une adresse IPv6, les mêmes en **AAAA**.) Vérifier : `ping admin.almaneo.fr` répond avec l'IP du serveur.

### A2. Certificat HTTPS « joker » (Nginx Proxy Manager)

Un certificat `*.almaneo.fr` s'obtient par **défi DNS** :

1. Chez le registraire, créer une **clé d'API DNS** (OVH : `api.ovh.com/createToken`, droits
   GET/POST/PUT/DELETE sur `/domain/zone/almaneo.fr/*`).
2. NPM → **SSL Certificates** → *Add SSL Certificate* → *Let's Encrypt* : domaines `almaneo.fr` et
   `*.almaneo.fr`, cocher **Use a DNS Challenge**, choisir le registraire, coller les identifiants.

### A3. La deuxième installation

```bash
cd /opt/docker-compose
```

```bash
git clone -b multi-casernes "$(git -C /opt/docker-compose/calendriers-pompiers remote get-url origin)" almaneo
```

```bash
cd almaneo && cp .env.example .env && nano .env
```

Dans ce `.env` :

```
CONTAINER_NAME=almaneo
IMAGE_NAME=almaneo-backend
HOST_PORT=8001
PROXY_NETWORK=(le même que dans l'installation de Courzieu)
COOKIE_SECURE=true
ADMIN_PASSWORD=(une valeur longue quelconque : pas utilisé par les casernes)
PLATFORM_DB_PATH=/app/plateforme/plateforme.db
CASERNES_DIR=/app/plateforme/casernes
PLATFORM_DOMAIN=almaneo.fr
PLATFORM_ADMIN_PASSWORD=(mot de passe long et unique de l'admin central)
PLATFORM_CONTACT_EMAIL=(adresse affichée sur la vitrine, facultatif)
PLATFORM_EDITEUR=(votre nom, pour les mentions du site vitrine)
```

Puis :

```bash
docker compose up -d --build backend
```

### A4. Proxy dans Nginx Proxy Manager

NPM → **Proxy Hosts** → *Add Proxy Host* :

- Domain Names : `almaneo.fr`, `www.almaneo.fr`, `admin.almaneo.fr`, `*.almaneo.fr`
- Scheme `http`, Forward Hostname **`almaneo`**, Forward Port `8000`, *Block Common Exploits*
- onglet **SSL** : le certificat `*.almaneo.fr`, *Force SSL*, *HTTP/2 Support*.

Le proxy de **spcourzieu.fr** ne bouge pas (toujours vers `calendriers-pompiers`).

### A5. Vérifications

- [ ] https://almaneo.fr : le site vitrine ; le formulaire « Demander une démo » fonctionne.
- [ ] https://admin.almaneo.fr : l'admin central (mot de passe `PLATFORM_ADMIN_PASSWORD`) ; y créer
  votre **compte nominatif** (« Comptes de l'admin central »).
- [ ] Une caserne d'essai (« + Nouvelle caserne », identifiant `demo`, une commune) : https://demo.almaneo.fr
  s'ouvre, les communes se téléchargent, le guide de démarrage s'affiche. On peut l'archiver puis la supprimer ensuite.
- [ ] https://spcourzieu.fr : Courzieu, inchangé.

### Mettre à jour Almaneo

```bash
cd /opt/docker-compose/almaneo && git pull && docker compose up -d --build backend
```

(Courzieu se met à jour comme avant, dans son propre dossier.)

---

## B. Fin de saison : basculer Courzieu dans Almaneo

> Hors tournée, 15 minutes. La base de Courzieu n'est jamais modifiée : retour arrière possible.

1. Arrêter l'installation de Courzieu (plus aucune saisie pendant la copie) :

   ```bash
   cd /opt/docker-compose/calendriers-pompiers && docker compose stop backend
   ```

2. Copier ses données vers Almaneo :

   ```bash
   mkdir -p /opt/docker-compose/almaneo/data/import-courzieu && cp -a /opt/docker-compose/calendriers-pompiers/data/db /opt/docker-compose/calendriers-pompiers/data/sectors /opt/docker-compose/almaneo/data/import-courzieu/
   ```

3. **Essai** (n'écrit rien) — remplacer le mot de passe par l'actuel `ADMIN_PASSWORD` de Courzieu :

   ```bash
   cd /opt/docker-compose/almaneo && docker compose run --rm --name almaneo-bascule -v /opt/docker-compose/almaneo/data/import-courzieu:/import backend python -m app.basculer --source-db /import/db/status.db --source-data /import/sectors --slug courzieu --adresse spcourzieu.fr --admin-identifiant chef.courzieu --admin-nom "Prénom Nom" --admin-mot-de-passe "mot-de-passe-actuel" --essai
   ```

4. Si l'essai est bon, la même commande **sans `--essai`**.

5. Dans NPM, modifier le proxy de **spcourzieu.fr** : Forward Hostname **`almaneo`** (au lieu de
   `calendriers-pompiers`), port `8000`. Garder son certificat.

6. Vérifier :
   - [ ] https://spcourzieu.fr et https://courzieu.almaneo.fr : Courzieu, avec son écusson.
   - [ ] Un téléphone d'équipe déjà connecté : **toujours connecté**, maisons et dons là.
   - [ ] https://spcourzieu.fr/admin : connexion avec **chef.courzieu** (l'identifiant est obligatoire
     désormais) ; les autres comptes nominatifs (trésorier…) marchent aussi.
   - [ ] https://admin.almaneo.fr : Courzieu apparaît comme caserne.

L'ancienne installation reste arrêtée (et ses données intactes) : c'est la sauvegarde de sécurité.

### Retour arrière

Dans NPM, remettre `calendriers-pompiers` comme Forward Hostname de spcourzieu.fr, puis :

```bash
cd /opt/docker-compose/calendriers-pompiers && docker compose start backend
```

Ce qui a été saisi **après** la bascule est dans
`/opt/docker-compose/almaneo/data/plateforme/casernes/courzieu/db/status.db` ; pour le garder, l'installation
de Courzieu arrêtée, copier ce fichier sur `/opt/docker-compose/calendriers-pompiers/data/db/status.db`.

---

## Ensuite : une nouvelle caserne

Admin central → **+ Nouvelle caserne** (nom, identifiant, premier compte administrateur, communes).
Elle est aussitôt sur `<identifiant>.almaneo.fr` (DNS et certificat joker) ; son responsable est guidé
à sa première connexion. Une caserne peut aussi garder son propre domaine (comme spcourzieu.fr) :
l'ajouter dans « Adresse(s) du site », faire pointer son DNS vers le serveur et créer son proxy dans NPM
(vers `almaneo`).
