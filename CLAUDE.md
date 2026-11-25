# Calendriers des pompiers — notes pour le développement

- Application en service pour les sapeurs-pompiers de Courzieu (Courzieu + Brussieu) : la branche
  `main` est celle déployée sur le serveur. Éviter toute régression ; lancer `sh tests/run_tests.sh`
  avant de pousser.
- L'utilisateur écrit en français : répondre en français. Commandes de mise à jour, chacune seule dans
  son bloc de code :
  `git pull` puis `docker compose up -d --build backend` (dans /opt/docker-compose/calendriers-pompiers).
- **Branche `multi-casernes`** : préparation d'**Almaneo**, la version proposée à plusieurs casernes
  (admin central, personnalisation par caserne ; domaine prévu almaneo.fr). Elle n'est PAS déployée. Plan : `docs/MULTI-CASERNES.md` (sur la branche).
  **Après chaque changement poussé sur `main`, fusionner `main` dans `multi-casernes`** (`git merge main`,
  jamais de rebase) et adapter le nouveau code au fonctionnement multi-casernes si besoin.
  Ne jamais fusionner `multi-casernes` dans `main` sans accord explicite.
