# Mise en service d'Almaneo (bascule de Courzieu)

Ce guide fait passer le serveur actuel (spcourzieu.fr, une seule caserne) à la plateforme **Almaneo** :
`admin.almaneo.fr` pour l'admin central, `courzieu.almaneo.fr` pour Courzieu — et **spcourzieu.fr
continue de marcher** (mêmes liens, mêmes codes, téléphones toujours connectés).

> À faire **hors période de tournée**. Compter 30 minutes, plus le temps de propagation du DNS.
> Rien n'est perdu en cas de souci : la base actuelle n'est jamais modifiée (voir « Retour arrière »).

## 0. Avant le jour J

- [ ] Demander la **fusion de la branche `multi-casernes` dans `main`** (Claude). Sans les réglages
  ci-dessous, la version fusionnée se comporte exactement comme aujourd'hui : on peut la déployer
  à l'avance (`git pull` + `docker compose up -d --build backend`) et vérifier que tout va bien.
- [ ] Connaître l'**adresse IP publique** du serveur (celle vers laquelle pointe déjà spcourzieu.fr).

## 1. DNS (chez le registraire d'almaneo.fr)

Dans la zone DNS d'`almaneo.fr`, ajouter deux enregistrements de type **A** vers l'IP du serveur :

| Sous-domaine | Type | Cible | Rôle |
|---|---|---|---|
| `admin` | A | IP du serveur | admin central (admin.almaneo.fr) |
| `*` | A | IP du serveur | toutes les casernes (courzieu.almaneo.fr, …) |

(Si le serveur a aussi une adresse IPv6, ajouter les mêmes en **AAAA**.) Ne rien changer pour spcourzieu.fr.
Vérifier au bout de quelques minutes : `ping courzieu.almaneo.fr` doit répondre avec l'IP du serveur.

## 2. Certificat HTTPS « joker » (Nginx Proxy Manager)

Un certificat pour `*.almaneo.fr` ne peut s'obtenir que par **défi DNS** : NPM doit pouvoir créer un
enregistrement temporaire chez le registraire.

1. Chez le registraire, créer une **clé d'API DNS** (chez OVH : « Créer des tokens API » sur
   `api.ovh.com/createToken`, avec les droits GET/POST/PUT/DELETE sur `/domain/zone/almaneo.fr/*`).
2. NPM → **SSL Certificates** → *Add SSL Certificate* → *Let's Encrypt* :
   - Domain Names : `almaneo.fr` et `*.almaneo.fr`
   - cocher **Use a DNS Challenge**, choisir le registraire, coller les identifiants d'API
   - accepter les conditions → *Save*.

## 3. Proxy dans Nginx Proxy Manager

NPM → **Hosts → Proxy Hosts** → *Add Proxy Host* :

- Domain Names : `admin.almaneo.fr` et `*.almaneo.fr`
- Scheme `http`, Forward Hostname `calendriers-pompiers`, Forward Port `8000`
- *Block Common Exploits* coché
- onglet **SSL** : le certificat `*.almaneo.fr`, *Force SSL*, *HTTP/2 Support*.

Le proxy existant de **spcourzieu.fr** reste tel quel (même conteneur).

## 4. Réglages du serveur (`.env`)

Dans `/opt/docker-compose/calendriers-pompiers/.env`, ajouter :

```
PLATFORM_DB_PATH=/app/plateforme/plateforme.db
CASERNES_DIR=/app/plateforme/casernes
PLATFORM_DOMAIN=almaneo.fr
PLATFORM_ADMIN_PASSWORD=un-mot-de-passe-long-et-unique
```

(`COOKIE_SECURE=true` doit déjà y être.) **Ne pas encore redémarrer.**

## 5. Le jour J : la bascule

Dans `/opt/docker-compose/calendriers-pompiers` :

1. Copie de sécurité de toutes les données :

   ```bash
   cp -a data "data-avant-almaneo-$(date +%F)"
   ```

2. Arrêter le site (pour qu'aucune saisie n'arrive pendant la copie) :

   ```bash
   docker compose stop backend
   ```

3. Construire la nouvelle version :

   ```bash
   docker compose build backend
   ```

4. **Essai** (n'écrit rien, affiche ce qui va être repris) :

   ```bash
   docker compose run --rm --name almaneo-bascule backend python -m app.basculer --slug courzieu --adresse spcourzieu.fr --admin-identifiant chef.courzieu --admin-nom "Prénom Nom" --essai
   ```

5. Si l'essai est bon, la **bascule** (même commande sans `--essai`) :

   ```bash
   docker compose run --rm --name almaneo-bascule backend python -m app.basculer --slug courzieu --adresse spcourzieu.fr --admin-identifiant chef.courzieu --admin-nom "Prénom Nom"
   ```

   Le compte `chef.courzieu` remplace l'ancien « compte principal » : même mot de passe
   (`ADMIN_PASSWORD`), sauf si on en donne un autre avec `--admin-mot-de-passe`. Les comptes
   nominatifs existants (trésorier…) continuent de marcher.

6. Redémarrer :

   ```bash
   docker compose up -d backend
   ```

## 6. Vérifications

- [ ] https://spcourzieu.fr : le site public de Courzieu, avec son écusson.
- [ ] https://spcourzieu.fr/equipe sur un téléphone déjà connecté : **toujours connecté**, maisons et dons là.
- [ ] https://spcourzieu.fr/admin : connexion avec **chef.courzieu** (identifiant obligatoire désormais).
- [ ] https://courzieu.almaneo.fr : le même site.
- [ ] https://admin.almaneo.fr : l'admin central (mot de passe `PLATFORM_ADMIN_PASSWORD`) ; Courzieu y
  apparaît comme première caserne. Créer ensuite son **compte nominatif** dans « Comptes de l'admin central ».

## Retour arrière

La base d'origine (`data/db/status.db`) n'est jamais modifiée par la bascule. Pour revenir à l'ancien
fonctionnement : retirer (ou commenter) les quatre lignes `PLATFORM_*` du `.env`, puis
`docker compose up -d backend`.

Attention : ce qui a été saisi **après** la bascule est dans `data/plateforme/casernes/courzieu/db/status.db`.
Pour le garder en revenant en arrière, site arrêté, copier ce fichier sur `data/db/status.db`.

## Ensuite : une nouvelle caserne

Admin central → **+ Nouvelle caserne** (nom, identifiant, premier compte administrateur, communes).
Elle est aussitôt joignable sur `<identifiant>.almaneo.fr` (le DNS joker et le certificat joker
couvrent toutes les casernes) ; son responsable est guidé à sa première connexion.
