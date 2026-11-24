# Version multi-casernes — plan de travail

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

## Questions ouvertes

- Nom de domaine de la plateforme (pour les sous-domaines).
- Hébergement : toutes les casernes sur le serveur actuel ?
- Les casernes paieront-elles (abonnement) ? Si oui, à prévoir plus tard (étape séparée).
