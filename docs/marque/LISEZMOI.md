# Almaneo — fichiers de la marque

Direction artistique : **bleu marine et rouge pompier**. Le symbole réunit un casque de sapeur-pompier et une
page de calendrier avec un parcours (point de carte, maison) ; le nom **Almaneo** est en italique gras, le
« o » final en rouge, souligné d'un trait rouge. Slogan : « La tournée calendrier des sapeurs-pompiers —
simple • mobile • collaborative ».

| Fichier | Usage |
|---|---|
| `originaux/` | les fichiers tels que livrés (logo complet, icône, monochrome), fond blanc ou noir |
| `almaneo-logo-complet-transparent.png` | logo avec slogan, fond transparent — pour fond clair |
| `almaneo-logo-court-transparent.png` | symbole + nom sans slogan — en-têtes de site, petites tailles |
| `almaneo-logo-monochrome-transparent.png` | version noire (tampon, impression une couleur) — sur fond clair |
| `almaneo-symbole-transparent.png` | le symbole seul |
| `almaneo-icone-carree.png` | icône d'application, carré plein (iOS et Android arrondissent eux-mêmes) |
| `almaneo-icone-arrondie.png` | icône aux coins arrondis, fond transparent (présentations, réseaux sociaux) |
| `almaneo-favicon-64.png` | onglet du navigateur : le symbole seul sur fond marine (le nom serait illisible) |
| `almaneo-partage-1200x630.png` | image affichée quand on partage almaneo.fr (WhatsApp, Facebook, LinkedIn…) |

Sur le site, les fichiers servis sont dans `frontend/img/almaneo/` (logo d'en-tête, favicons, icônes, image de partage).

**Couleurs** : marine `#0B1F44` (texte du logo ≈ `#011D43`), rouge `#E3141B`, rouge foncé `#B80F16`.
**Fond foncé** : utiliser l'icône (nom en blanc sur marine) ; les logos transparents sont faits pour un fond clair.

Les fichiers livrés sont des images (pixels), pas des vecteurs : pour de l'impression en grand format
(banderole, véhicule), demander au graphiste une version **vectorielle** (SVG, AI ou PDF).

`preparer.py` régénère les fichiers dérivés à partir des originaux (Python + Pillow).
