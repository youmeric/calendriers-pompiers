# Calendriers des pompiers — notes pour le développement

- Application en service pour les sapeurs-pompiers de Courzieu (Courzieu + Brussieu) : la branche
  `main` est celle déployée sur le serveur. Éviter toute régression ; lancer `sh tests/run_tests.sh`
  avant de pousser.
- L'utilisateur écrit en français : répondre en français. Commandes de mise à jour, chacune seule dans
  son bloc de code :
  `git pull` puis `docker compose up -d --build backend` (dans /opt/docker-compose/calendriers-pompiers).
- **Branche `multi-casernes`** : **Almaneo**, la version proposée à plusieurs casernes (admin central,
  personnalisation par caserne). **En service depuis le 25/11/2026** comme deuxième installation sur le
  même serveur : `/opt/docker-compose/almaneo` (conteneur `almaneo`) sert almaneo.fr (vitrine),
  admin.almaneo.fr et *.almaneo.fr. Mise à jour : `cd /opt/docker-compose/almaneo && git pull && docker compose
  up -d --build backend`. Tester avant de pousser la branche, comme `main`. Courzieu reste sur `main`
  jusqu'à sa bascule en fin de saison (guide : `docs/MISE-EN-SERVICE.md`, partie B ; plan : `docs/MULTI-CASERNES.md`).
  **Après chaque changement poussé sur `main`, fusionner `main` dans `multi-casernes`** (`git merge main`,
  jamais de rebase) et adapter le nouveau code au fonctionnement multi-casernes si besoin.
  Ne jamais fusionner `multi-casernes` dans `main` sans accord explicite.
