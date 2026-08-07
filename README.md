# CompaGelato

Logiciel de gestion pour ordinateur (Windows, macOS, Linux). Il ne remplace pas
votre logiciel de comptabilité : il **lit** les factures et devis que celui-ci
produit, les range dans des tableaux, tient votre stock de consommables à jour
et calcule vos tournées de livraison.

Tout reste sur votre machine. Aucun compte, aucun serveur, aucun abonnement.
(Seule exception, désactivée par défaut : les notifications sur téléphone
passent par le serveur ntfy configuré dans les réglages.)

---

## Ce que fait le logiciel

**Lecture automatique de vos documents comptables**
Vous déposez vos fichiers dans un dossier, le logiciel s'occupe du reste. Il
surveille ce dossier en permanence et lit :

| Format | Ce qui est extrait |
|---|---|
| PDF | Numéro, date, échéance, client, lignes d'articles, totaux HT/TVA/TTC |
| PDF Factur-X / ZUGFeRD | Les données XML embarquées — lecture exacte, sans interprétation |
| XML Factur-X (CII) et UBL 2.1 (Chorus Pro, Peppol) | Idem |
| CSV / Excel | Journaux de ventes, une ligne par pièce ou une ligne par article |

Un document dont le nom du client n'est précédé d'aucun libellé (« Client : »,
« Facturé à »…) est tout de même rattaché : le texte de la pièce est comparé aux
clients déjà connus.

Certains logiciels de facturation impriment le bloc vendeur et le bloc client
côte à côte, sur les mêmes lignes visuelles (« Siret : ...   N° client : ... »).
CompaGelato détecte ce mélange — un code client n'est jamais pris pour un nom,
les libellés de contact du vendeur (Tél., Port., Email...) qui se glissent dans
l'adresse du client sont retirés, et l'appariement des colonnes du tableau
d'articles respecte l'ordre gauche→droite plutôt que la seule position, ce qui
évite qu'une valeur légèrement décalée (alignement à droite) ne tombe dans la
mauvaise colonne.

Les fichiers d'origine ne sont **jamais** modifiés ni déplacés. Un fichier déjà
importé et inchangé est ignoré : rescanner ne crée pas de doublon.

**Vos corrections tiennent.** Si vous rattachez une facture au bon client,
rectifiez un total mal lu ou saisissez une échéance, une relecture du fichier ne
défait rien : les champs corrigés à la main sont mémorisés comme tels. Les
repères d'impression et d'envoi survivent également. Les emplacements de
fichiers sont enregistrés relativement au dossier de travail, si bien que
déplacer ce dossier ne réimporte rien en double.

**Carnet de clients**
Import de votre liste depuis CSV ou Excel, avec reconnaissance automatique des
colonnes (nom, adresse, code postal, e-mail, SIRET…). Les factures se rattachent
seules à la bonne fiche — par SIRET, par nom exact, puis par ressemblance. Quand
vous corrigez un rattachement, le nom lu sur la facture est mémorisé : la fois
suivante, c'est automatique.

**Stock**
Le stock ne contient pas que des consommables : chaque article porte une
**nature** — consommable (mix, coupelles, cornets…), **machine** (glace,
granité…) ou **pièce détachée**. Le tableau se filtre par nature, et les cahiers
piochent dedans : les pièces sont proposées en priorité au SAV, les
consommables dans les commandes.

La fiche article s'adapte à ce que vous saisissez. Un **mix glace liquide** se
vend au carton de deux poches de 4,5 kg ; un **mix poudre** se vend à la poche
de 2,5 kg mais se facture **au kilo**. Vous renseignez donc le conditionnement
(contenu d'une unité, nombre d'unités par carton, et ce que compte réellement la
facture), et le logiciel fait la conversion tout seul : 12,5 kg de mix poudre
facturés sortent **5 poches** du stock, pas 12,5. Machines et pièces détachées,
qui se comptent à l'unité, n'affichent pas ces champs.

Vous saisissez ou importez vos articles. À
chaque facture, les lignes sont rapprochées de vos articles — par référence, par
libellé déjà connu, puis par ressemblance — et les quantités sont sorties du
stock. L'opération est réversible et jamais appliquée deux fois. Chaque
mouvement est daté et traçable. Un devis n'impacte pas le stock ; un avoir
réintègre la marchandise.

**Impression et envoi**
Depuis le tableau des documents, en un clic : ouvrir le fichier d'origine,
l'imprimer (l'icône passe au vert une fois l'impression faite, pour savoir d'un
coup d'œil ce qui reste à sortir), ou préparer un e-mail. Le message est
pré-rempli d'après vos modèles, avec le document en pièce jointe et vos flyers
à cocher ou décocher. Il s'ouvre en brouillon dans votre messagerie : rien n'est
envoyé sans votre relecture.

**Relevés de compte et rapprochement bancaire**
Vous déposez les relevés exportés par votre banque (CSV ou Excel) dans un
dossier — celui que vous utilisez déjà, où qu'il soit sur le disque. Toutes les
mises en page courantes sont lues : colonnes Débit/Crédit séparées, colonne
Montant unique signée, ou montant positif accompagné d'une colonne de sens.

Les exports bancaires commencent souvent par un bloc de titre — nom du compte,
RIB, solde initial — avant la vraie ligne d'en-tête. CompaGelato la retrouve
toute seule : une ligne de titre étalée sur des cellules fusionnées répète la
même valeur partout, et un en-tête ne contient ni dates ni montants. Vous
déposez le fichier tel que la banque vous le donne, sans rien retoucher.

Chaque opération est identifiée par sa date, son montant et son libellé, avec un
rang d'occurrence. Conséquence : **réimporter un relevé, ou importer deux
fichiers qui se chevauchent, ne crée jamais de doublon** — tout en gardant les
opérations réellement identiques d'une même journée (deux paiements du même
montant au même endroit restent deux lignes).

Une banque ne libelle pas toujours la même ligne pareil : le relevé mensuel
tronque le motif là où l'export annuel le donne en entier. `VIR INST TIKTAK
GARE` et `VIR INST TIKTAK GARE LE RESTE FACTURE TIKTAK` sont la même opération.
CompaGelato les rapproche à condition que le doute soit levé — même jour, même
montant au centime, et le libellé court exactement le début du long, coupé sur
une fin de mot, avec au moins trois mots. Deux libellés voisins mais distincts
restent deux opérations : mieux vaut un doublon visible, qui se supprime d'un
clic, qu'une recette effacée en silence. Le libellé le plus complet est conservé.

Le bouton **Doublons** rattrape ce qui a déjà été enregistré en double. Il
montre d'abord ce qui va disparaître — date, montant, les deux libellés — et ne
supprime qu'après validation. Le comptage est prudent : si un virement a
réellement eu lieu deux fois, il en reste deux. La facture rapprochée, le solde
et vos annotations passent sur la ligne conservée.

Les encaissements sont rapprochés des factures automatiquement : numéro de pièce
cité dans le libellé, montant, nom du client, cohérence des dates. Une facture
rapprochée passe à « réglée » — vous voyez d'un coup d'œil qui a payé et qui
reste à relancer. En cas d'ambiguïté (deux factures du même montant, sans autre
indice), l'opération est laissée à traiter à la main plutôt que mal affectée.

Les dépenses sont classées automatiquement d'après le libellé (charges et
impôts, fournisseurs, carburant, salaires, assurances, frais bancaires…),
modifiable d'un clic. Le tout donne les totaux par catégorie et l'évolution de la
trésorerie mois par mois.

**Tableaux triables et filtres**
Chaque colonne des tableaux (documents, clients, stock, banque, mouvements) se
trie d'un clic sur son en-tête ; un second clic inverse le sens. Les dates et
les montants s'ouvrent du plus grand au plus petit, les textes de A à Z, et les
numéros suivent l'ordre naturel des nombres (`FAC…009` avant `FAC…010`). Les
lignes sans valeur restent en bas quel que soit le sens : une facture sans
montant n'a rien à faire en tête du classement des plus gros montants.

Les relevés bancaires se filtrent en plus sur une période libre (du … au …),
cumulable avec le mois, la catégorie, le sens et l'état de rapprochement.

La recherche accepte aussi bien du texte qu'un **montant** : taper `482`
retrouve l'opération de 482,96 €, `115,56` la facture de ce total. Le signe est
ignoré (un débit se cherche comme un crédit), les espaces et le `€` sont
tolérés, et une facture se retrouve par son HT, sa TVA ou son TTC.

**Cahiers : SAV, consommables, événementiel**
Les trois cahiers papier de l'entreprise, dans un seul onglet. Chaque écriture
choisit un client existant, crée sa fiche en un clic, ou note simplement un nom
au vol. Le SAV enregistre la cause de la panne, les pièces demandées et un
commentaire ; les consommables les commandes de mix, gobelets et pots ;
l'événementiel la date de la prestation et les machines demandées.

Les pièces et les articles commandés sont **rattachés au stock** : on les
choisit dans le catalogue, avec la quantité et le niveau de stock affichés. Un
article absent du catalogue reste notable en libellé libre — une prise de note
ne doit jamais être bloquée par une référence manquante.

Chaque écriture s'ajoute en un clic à une **tournée de livraison** : l'arrêt
reprend l'adresse de la fiche client, avec la cause ou l'objet en note. Deux
écritures pour le même client complètent le même arrêt au lieu d'en créer deux.

Le parc de machines est suivi dans le même onglet, avec une règle stricte :
**une simple demande ne réserve rien — seul le passage en « Devis validé »
retire les machines du parc**, et elles y reviennent quand la prestation est
terminée ou annulée. La disponibilité est calculée à partir du cahier lui-même,
jamais stockée : elle ne peut pas se désynchroniser. Valider un devis au-delà du
parc est refusé en nommant la machine manquante, et une machine réservée ne peut
pas être retirée du parc.

Chaque ajout peut prévenir toute l'équipe sur téléphone : installez
l'application gratuite ntfy et abonnez chaque téléphone au sujet configuré dans
les réglages (désactivé par défaut).

**Calculateur de tournées de livraison**

- Recherche d'adresse avec auto-complétion (Base Adresse Nationale)
- Carnet de clients intégré : les arrêts se piochent dans vos fiches
- Feuille de route multi-arrêts, réordonnable au glisser-déposer
- Épinglage : un arrêt épinglé garde sa position, l'optimisation travaille autour
- Optimisation mathématique du trajet — solution **exacte** jusqu'à 10 arrêts
  (programmation dynamique de Held-Karp), heuristique 2-opt / Or-opt au-delà
- Coût réel : carburant (prix du jour relevable en un clic sur les données
  publiques), usure kilométrique, temps chauffeur, péages
- Envoi sur le téléphone : QR code à scanner qui ouvre l'itinéraire complet dans
  Google Maps, Waze ou Plans

---

## Installation

### Utiliser le logiciel

```bash
npm install
npm run dist:win     # installateur Windows (.exe) → dossier release/
```

`npm run dist:mac` et `npm run dist:linux` produisent respectivement un `.dmg`
et un `.AppImage`. Chaque cible doit être construite depuis le système
correspondant (ou avec Wine pour Windows depuis Linux).

Pour lancer sans installer :

```bash
npm start
```

### Lancement quotidien sans terminal (Windows)

Une fois `npm install` fait une première fois :

1. Double-cliquez sur **`Creer-Raccourci.bat`** — une seule fois. Il crée un
   raccourci « CompaGelato » sur le Bureau.
2. Ensuite, utilisez uniquement ce raccourci pour lancer le logiciel : aucune
   fenêtre noire, aucune commande à taper, aucun souci de politique
   d'exécution PowerShell (le raccourci passe par `cmd`/`wscript`, non
   soumis à cette restriction).

En cas d'échec au démarrage, un journal s'ouvre automatiquement dans le
Bloc-notes pour pouvoir le transmettre facilement.

### Développer

```bash
npm run dev          # rechargement à chaud de l'interface
npm run typecheck    # vérification TypeScript des deux processus
npm test             # tests unitaires
npm run test:e2e     # tests de bout en bout (lance l'application réelle)
```

Sur un serveur sans écran, préfixez les tests de bout en bout par
`xvfb-run -a`.

---

## Premiers pas

1. **Réglages → Dossier surveillé.** Par défaut
   `C:\Users\<vous>\Documents\CompaGelato`. Les sous-dossiers `Factures`,
   `Devis`, `Avoirs`, `Clients` et `Exports` sont créés automatiquement.
2. **Clients → Importer une liste.** Choisissez l'export de votre logiciel de
   comptabilité (CSV ou Excel). Le récapitulatif indique quelles colonnes ont
   été reconnues.
3. **Clients → Géolocaliser.** Ce bouton apparaît tant que des fiches n'ont pas
   de position GPS connue ; il la recherche en lot pour les rendre utilisables
   dans les tournées.
4. **Stock → Nouveau consommable** (ou Importer). Renseignez la référence, la
   quantité et le seuil d'alerte.
5. **Déposez vos factures** dans `Documents\CompaGelato\Factures`. Elles
   apparaissent en quelques secondes.
6. **Documents.** Vérifiez l'association des lignes au stock, puis
   « Déduire du stock ».
7. **Réglages → Pièces jointes réutilisables.** Ajoutez vos flyers une fois pour
   toutes ; ils seront ensuite proposés à cocher à chaque envoi.
8. **Tournées.** Le dépôt (27 rue Jacques Daguerre, Saint-Nazaire) est déjà
   renseigné. Ajoutez vos arrêts, épinglez ceux qui doivent rester en place,
   optimisez, puis envoyez sur le téléphone.

Le bouton **Charger la démonstration** (Réglages → Données) remplit le logiciel
avec un jeu d'essai complet, retirable d'un clic.

**Réglages → Mises à jour → Rechercher les mises à jour.** Le logiciel
compare sa version au dépôt en ligne ; s'il existe une nouveauté, un résumé
s'affiche et un bouton « Installer la mise à jour » récupère les derniers
changements, réinstalle les dépendances si besoin et reconstruit le
logiciel automatiquement. Il ne reste qu'à cliquer sur « Redémarrer
maintenant ». Cette fonctionnalité nécessite que le logiciel tourne depuis le
dossier cloné du dépôt (c'est le cas avec le lancement par raccourci
ci-dessus) — elle ne s'applique pas à un installateur `.exe` publié.

---

## Où sont mes données

Un unique fichier JSON dans le dossier de profil de l'application :

| Système | Emplacement |
|---|---|
| Windows | `%APPDATA%\CompaGelato\compagelato-data.json` |
| macOS | `~/Library/Application Support/CompaGelato/` |
| Linux | `~/.config/CompaGelato/` |

Les écritures sont atomiques (fichier temporaire puis renommage) : une coupure
de courant ne peut pas corrompre la base. Vingt sauvegardes tournantes sont
conservées dans le sous-dossier `backups`, et une base illisible est
automatiquement remplacée par la dernière sauvegarde valide.

Réglages → Données permet de sauvegarder, restaurer et exporter à tout moment.

## Mode serveur : les mêmes données partout

CompaGelato sait aussi tourner en **serveur** : un simple processus Node — sans
Electron, sans dépendance à compiler — qui détient la base et les PDF, surveille
le dossier de comptabilité, et sert **l'application complète dans le
navigateur** de n'importe quel appareil du réseau. C'est la première étape du
mode multi-postes : un seul écrivain, plus aucun risque de bases divergentes
entre le bureau et la maison.

```bash
# Sur la machine qui héberge (vieux PC, mini-PC, Raspberry Pi…)
git clone <dépôt> CompaGelato-App && cd CompaGelato-App
npm ci
COMPAGELATO_TOKEN=un-secret-long npm run server
```

Puis, depuis n'importe quel PC ou téléphone du réseau :
`http://<ip-du-serveur>:4680/?token=un-secret-long` — le jeton est mémorisé par
l'appareil, l'adresse se garde en favori.

| Variable | Rôle | Défaut |
|---|---|---|
| `COMPAGELATO_DATA_DIR` | Dossier de la base et des sauvegardes | `~/.compagelato` |
| `COMPAGELATO_PORT` | Port d'écoute | `4680` |
| `COMPAGELATO_HOST` | Adresse d'écoute | `0.0.0.0` |
| `COMPAGELATO_TOKEN` | Jeton exigé pour l'API et les fichiers | *(aucun — à renseigner !)* |

Ce qui marche dans le navigateur : tout — tableaux, recherche, tournées,
cahiers, banque, imports (le « choisir un fichier » téléverse vers le serveur),
ouverture des PDF dans un onglet, e-mail (le brouillon `.eml` se télécharge,
prêt à ouvrir dans la messagerie). Seules les actions qui ouvrent une fenêtre
sur le poste (sélecteur de dossier…) restent propres à l'application de bureau,
avec un message clair.

### Envoyer une facture au serveur, sans rien installer

Depuis l'écran **Documents**, le bouton **Ajouter des pièces** envoie une ou
plusieurs factures au serveur : elles sont rangées dans le dossier surveillé,
analysées, et apparaissent aussitôt sur tous les appareils. Ça marche
identiquement dans le navigateur et dans l'application de bureau branchée.

C'est ce qui rend un poste utilisable **immédiatement** : installer, saisir
l'adresse du serveur, et déposer ses factures. Aucun partage réseau ni
synchronisation de dossier n'est nécessaire — ils restent utiles pour un dépôt
automatique, mais ne conditionnent plus rien.

Redéposer un fichier déjà connu ne crée pas de doublon : le contenu est comparé,
et une pièce dont l'empreinte est déjà en base est mise à jour plutôt que
recréée.

### Brancher l'application de bureau sur le serveur

Le navigateur n'est pas la seule façon d'atteindre les données partagées :
l'application de bureau sait s'y brancher, **en gardant les gestes du poste**.
Dans **Réglages → Serveur**, saisissez l'adresse (`192.168.1.99:4680`) et le
jeton, puis redémarrez.

L'application lit et écrit alors sur le serveur — mêmes factures, mêmes clients,
mêmes tournées que sur les autres appareils — mais **imprime sur votre
imprimante**, ouvre les PDF dans **votre** lecteur, et prépare les brouillons
d'e-mail dans **votre** messagerie avec leurs pièces jointes. Le fichier est
rapatrié du serveur juste avant le geste, puis remis au poste.

Ce qui change une fois branché :

- Les **dossiers désignés sont ceux du serveur**. Le sélecteur natif laisserait
  croire le contraire : les chemins se saisissent donc au clavier, et les
  boutons « Ouvrir le dossier » disparaissent.
- Les **exports CSV** sont écrits sur le serveur, à l'emplacement indiqué par le
  message de confirmation.
- La **mise à jour** depuis l'écran Réglages met à jour le serveur, pas le poste.
- Serveur éteint au démarrage ? L'application le signale et propose de
  réessayer, de travailler sur les données du poste, ou de quitter. Elle ne
  bascule jamais en silence : croire qu'on écrit sur le serveur alors qu'on
  écrit en local serait bien pire qu'un message.

La liaison est enregistrée dans `connexion.json`, à côté de la base locale. Elle
appartient à l'appareil et n'est jamais synchronisée — sinon chaque poste
enverrait ses voisins chez lui. `COMPAGELATO_SERVER_URL` et
`COMPAGELATO_SERVER_TOKEN` l'emportent, pour configurer un poste par script.

Notes de fonctionnement :

- **Une seule instance écrit.** N'ouvrez pas l'application de bureau *en mode
  local* pendant que le serveur tourne sur le même dossier de données : le
  magasin n'a pas de verrou, le dernier qui écrit gagne. Branchez-la sur le
  serveur (ci-dessus) — c'est précisément ce qui supprime le problème.
- Service permanent sous Linux : créez `/etc/systemd/system/compagelato.service` :

  ```ini
  [Unit]
  Description=CompaGelato serveur
  After=network.target

  [Service]
  User=compagelato
  WorkingDirectory=/home/compagelato/CompaGelato-App
  Environment=COMPAGELATO_DATA_DIR=/home/compagelato/donnees
  Environment=COMPAGELATO_TOKEN=un-secret-long
  ExecStart=/usr/bin/node dist/server/server.mjs
  Restart=always

  [Install]
  WantedBy=multi-user.target
  ```

  puis `systemctl enable --now compagelato`. La mise à jour depuis l'écran
  Réglages fonctionne : après « Installer », le service redémarre tout seul.
- Pour l'accès **hors du réseau local** (tournées, télétravail), installez
  [Tailscale](https://tailscale.com) sur le serveur et sur vos appareils :
  l'adresse `http://<nom-tailscale>:4680` marche alors de partout, chiffrée,
  sans ouvrir le moindre port sur la box.
### Comptes et rôles

Le jeton partagé protège les données, pas les personnes : tous ceux qui le
connaissent ont les mêmes droits. Les **comptes** y remédient.

| | Tournées | Clients | Documents | Stock | Banque | Tableau de bord | Réglages / Comptes |
|---|---|---|---|---|---|---|---|
| **Gérant** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Bureau** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Livreur** | ✅ | lecture | ❌ | ❌ | ❌ | ❌ | ❌ |

Le tableau de bord est refusé au livreur : il a l'air anodin, mais il expose le
chiffre d'affaires et les meilleurs clients.

**Rien ne change tant que vous ne créez pas de compte.** Un serveur déjà en
service continue de fonctionner au jeton partagé. Dès que le premier compte
existe, une connexion devient obligatoire et le jeton seul ne suffit plus —
sinon le rôle de chacun ne voudrait rien dire.

Pour démarrer : **Réglages → Comptes → Ajouter**, en gérant. Vous serez invité à
vous connecter au rechargement suivant.

Ce qui tient la sécurité :

- Le contrôle vit à **un seul endroit**, l'aiguillage du serveur. Aucun service
  métier ne vérifie quoi que ce soit.
- Une table déclarative associe chaque canal à ses rôles, écrite pour que
  **le compilateur exige qu'elle soit exhaustive** : ajouter un canal sans le
  classer fait échouer `npm run typecheck`. Ce n'est pas une discipline à tenir,
  c'est une impossibilité. Un contrôle au démarrage double la garantie.
- Le **téléchargement des fichiers applique le même contrôle** : sans cela,
  deviner un identifiant de document suffirait à récupérer une facture.
- Les mots de passe sont hachés avec **scrypt**, inclus dans Node — aucune
  dépendance nouvelle, l'installation du serveur reste `npm ci`.
- Les jetons de session sont **opaques et révocables** (pas de JWT) : quand un
  salarié part, son accès se coupe dans la seconde. Seule leur empreinte est
  enregistrée, si bien qu'une copie de la base ne permet pas d'usurper une
  session.
- Les tentatives de connexion sont **limitées**, par compte et par appareil, et
  un identifiant inconnu renvoie le même message qu'un mot de passe erroné.

### Hors ligne : l'application marche en zone blanche

L'application de bureau branchée garde une **copie locale** des données qui la
concernent (`miroir.json`, à côté de la base) et reste utilisable sans réseau :

- **Serveur injoignable ?** Les tableaux s'affichent depuis la copie locale, un
  bandeau « Hors ligne » l'indique dans la barre latérale, et l'application
  s'ouvre même serveur éteint — sans dialogue bloquant dès lors qu'une première
  synchronisation a eu lieu.
- **Vos modifications sont conservées.** Chaque geste fait hors ligne est
  journalisé comme une intention (`attente.json`) et **rejoué dans l'ordre** à
  la reconnexion — détectée automatiquement. L'écran reflète le geste tout de
  suite ; à la synchronisation suivante, la version du serveur fait foi.
- **Un rejeu refusé n'est jamais abandonné en silence.** Si la fiche visée a été
  supprimée entre-temps, l'opération est présentée dans **Réglages →
  Synchronisation**, avec son explication, à garder ou abandonner.

Le principe : **descendre des états, remonter des intentions.** Le serveur
numérote chaque modification (`rev`) et descend les deltas ; les suppressions
voyagent en pierres tombales (purgées à 90 jours — un appareil plus en retard
refait une synchronisation complète, de même qu'après une restauration de
sauvegarde, qui change la génération de la base). Le poste ne fusionne rien :
les conflits se résolvent sur le serveur, en rejouant les intentions contre
l'état réel — les règles métier ne sont écrites qu'une fois.

**Le stock est le seul cas qui demande mieux que « le dernier qui écrit
gagne »**, et il est traité : le stock est la **somme de ses mouvements**, pas
un nombre stocké. Deux appareils qui déduisent chacun la même facture hors
ligne produisent des mouvements aux **identifiants déterministes** — dérivés de
(document, ligne) — qui fusionnent au lieu de se cumuler. Le stock initial
(saisie, import) passe lui aussi par un mouvement, et les bases existantes
reçoivent un mouvement de reprise d'inventaire à la migration.

Restent en ligne uniquement : les analyses de dossier, les imports de fichiers,
le géocodage et le calcul d'itinéraire (services externes), et le tableau de
bord.

Ce qui n'est pas encore fait : le pré-téléchargement des PDF pour la tournée du
jour — hors ligne, les fichiers d'origine ne s'ouvrent pas encore.

## L'application mobile (Android et iPhone)

Le dossier `mobile/` contient l'application de téléphone — **une seule base de
code** (Expo / React Native) pour Android et iOS. Elle parle au même serveur,
avec les mêmes comptes et les mêmes droits que le bureau et le navigateur : un
livreur y voit trois onglets (Tournées, Clients, Réglages), un gérant les voit
tous.

**Le cœur de l'app est la tournée** : les arrêts dans l'ordre, naviguer
(Waze / Google Maps / Plans selon le réglage), appeler le client, et **marquer
livré** — la coche apparaît en vert sur l'écran du bureau. Le tout marche **en
zone blanche** : l'app garde un miroir local (même protocole `sync:pull` que
le bureau), les pointages faits sans réseau sont conservés et rejoués à la
reconnexion, et un rejeu refusé est présenté dans les Réglages, jamais avalé.
S'y ajoutent tous les écrans de gestion : documents (PDF partagé/imprimé
depuis le téléphone, e-mail pré-rempli), stock avec ajustement d'inventaire,
cahiers en prise de note rapide, banque en consultation, tableau de bord.

**Réseau** : l'app passe par Tailscale (`100.100.53.66:4680`, proposé
d'office). Vérifiez que Tailscale est activé sur le téléphone.

### Développer (iPhone, Expo Go)

```bash
cd mobile
npm install
npx expo start
```

Scannez le QR code avec Expo Go. Le serveur de dev et le téléphone doivent
être sur le même réseau (ou le tailnet).

### Installer sur un téléphone Android (APK)

Une fois, pour lier le projet à votre compte Expo :

```bash
cd mobile
npx eas init          # crée le projet EAS et inscrit son identifiant
npx eas update:configure
```

Puis, pour produire l'APK :

```bash
npx eas build -p android --profile preview
```

Le lien de téléchargement de l'APK s'affiche à la fin. Sur le téléphone :
installer Tailscale et se connecter au tailnet, autoriser l'installation
depuis cette source, installer l'APK, ouvrir CompaGelato — l'adresse du
serveur est proposée, il ne reste qu'à se connecter à son compte (session de
180 jours : le mot de passe ne se retape pas).

### Mettre à jour l'app sans réinstaller

Les mises à jour de code JavaScript partent **par les airs** :

```bash
cd mobile
npx eas update --channel preview --message "description du changement"
```

L'app installée vérifie **toute seule à chaque lancement**, et le bouton
**Réglages → Vérifier les mises à jour** sert quand elle reste ouverte des
journées entières : vérifier, télécharger, relancer — sans jamais toucher à
l'APK. (Seul l'ajout d'un nouveau module natif redemande un `eas build`.)

### Vérifier

Le cœur du client mobile (`mobile/src/core/`) ne dépend ni de React Native ni
d'Expo : la suite `tests/mobile.test.mjs` l'exerce contre un vrai serveur —
session d'appareil, miroir, coupure réelle, pointage hors ligne, rejeu — avec
la même rigueur que le reste du projet.

## Ce qui sort de votre ordinateur

Trois services publics, sollicités uniquement quand vous en avez besoin :

| Service | Quand | Ce qui est envoyé |
|---|---|---|
| [Base Adresse Nationale](https://adresse.data.gouv.fr) | Vous tapez une adresse | Le texte saisi |
| [OSRM](https://project-osrm.org) puis [Valhalla](https://valhalla1.openstreetmap.de) | Calcul d'itinéraire | Les coordonnées des arrêts |
| [Prix des carburants](https://data.economie.gouv.fr) | Bouton « Relever le prix » | Le code postal |

Aucune clé d'API n'est nécessaire. Si un service ne répond pas, le calcul de
tournée bascule sur une estimation hors-ligne (distance à vol d'oiseau majorée
de 35 %, vitesse moyenne selon la longueur du trajet) et l'interface le signale.
Vos documents, clients et stocks ne quittent jamais la machine.

---

## Architecture

```
electron/                 Processus principal (Node)
  main.ts                 Fenêtre, menu, cycle de vie
  preload.ts              Pont IPC — seule surface exposée à l'interface
  store.ts                Base JSON, écritures atomiques, sauvegardes
                          (indépendante d'Electron : chemins injectés)
  handlers.ts             Les gestionnaires métier, sans Electron — le même
                          registre sert le bureau (IPC) et le serveur (HTTP)
  ipc.ts                  Surcharges bureau (dialogues, impression, messagerie)
                          et enregistrement IPC — en local comme en branché
  connection.ts           Liaison de l'appareil au serveur (adresse, session),
                          hors base : elle appartient à la machine
  context.ts              Qui appelle, pour la durée d'une requête — sans
                          toucher aux signatures des gestionnaires
  remote.ts               Proxy HTTP du processus principal : les canaux métier
                          renvoyés au serveur, fichiers rapatriés, flux SSE
  offline.ts              Miroir local, file d'attente d'intentions et rejeu :
                          le mode branché qui survit aux coupures
  server.ts               Serveur HTTP zéro dépendance : API, SSE, fichiers,
                          téléversements, interface web
  serverMain.ts           Point d'entrée du mode serveur
  watcher.ts              Surveillance du dossier
  services/
    auth.ts               Comptes, mots de passe scrypt, sessions révocables
    mail.ts               Brouillons .eml multipart avec pièces jointes
    printing.ts           Impression via la boîte de dialogue du système
    attachments.ts        Bibliothèque de flyers réutilisables
    updater.ts            Mise à jour par git (vérifier / appliquer)
    pdf.ts                Extraction PDF, reconstruction lignes et colonnes
    parseInvoice.ts       Lecture des factures/devis français
    facturx.ts            Factur-X (CII) et UBL 2.1
    tabular.ts            CSV/Excel : séparateur, encodage, colonnes
    documents.ts          Analyse du dossier, dédoublonnage, ingestion
    bankStatement.ts      Relevés : colonnes, empreintes, catégories, score de
                          rapprochement (sans accès à la base — testable seul)
    bank.ts               Import des relevés, rapprochement, trésorerie
    clients.ts            Import, rapprochement, fusion
    stock.ts              Rapprochement articles, mouvements
    routing.ts            Adresses, matrices de distances, carburants
    optimize.ts           Voyageur de commerce avec contraintes d'épinglage
    routes.ts             Calcul de coût, optimisation d'une tournée
    dashboard.ts          Agrégats
    exports.ts            Exports CSV
src/                      Interface React
shared/                   Types, contrat IPC, table des droits par canal et
                          protocole de synchronisation (révisions, tombstones)
tests/                    Tests unitaires et de bout en bout
```

L'interface n'a aucun accès à Node : elle passe par `window.api`, généré à
partir de la table des canaux `shared/api.ts`. Le contrat TypeScript et les
canaux réellement exposés ne peuvent donc pas diverger.

Aucune dépendance native : l'installation ne compile rien, et le logiciel
survit aux mises à jour d'Electron sans recompilation.

---

## Tests

```bash
npm run test:all
```

- **109 tests unitaires** — lecture de nombres et dates français, CSV avec
  guillemets et sauts de ligne, décodage Windows-1252, reconnaissance de
  colonnes, extraction PDF sur de vraies factures, Factur-X et UBL, optimisation
  de tournée (comparée à une recherche exhaustive), respect des épinglages,
  tri des tableaux (ordre naturel des numéros, alphabet français, valeurs
  manquantes rejetées en fin de liste, stabilité), recherche par montant
  (chiffres partiels, signe ignoré, séparateurs de milliers, texte jamais lu
  comme un montant),
  liens Google Maps / Waze / Plans, lecture des réponses OSRM et Valhalla,
  construction des messages MIME avec pièces jointes accentuées, gabarit de
  facture à deux colonnes (vendeur/client sur les mêmes lignes, tableau
  récapitulatif de TVA confondu avec un total), facture **sur deux pages**
  (en-tête vendeur réimprimé en haut de la page 2, pied de page légal et total
  répétés en bas de chaque page), facture **tamponnée** d'un filigrane
  « BROUILLON » en diagonale et « DUPLICATA » en gros caractères,
  conversion des unités de conditionnement (carton de deux poches, mix poudre
  facturé au kilo), et le mécanisme de mise à
  jour git (détection, application, refus prudent si des fichiers locaux ont
  été modifiés) validé sur un vrai dépôt temporaire.
- **25 de ces tests portent sur les relevés bancaires** — les trois mises en
  page de montants (Débit/Crédit, montant signé, montant + sens), le bloc de
  titre d'un export Crédit Mutuel dont l'en-tête n'arrive qu'en cinquième
  ligne (et son garde-fou : un fichier ordinaire continue de commencer par sa
  première ligne), les lignes de
  total et de solde écartées, la catégorisation des dépenses, et surtout le
  dédoublonnage : même relevé relu deux fois, deux relevés qui se chevauchent,
  et deux opérations réellement identiques le même jour qui doivent rester
  distinctes. Le score de rapprochement est vérifié sur ses cas limites —
  encaissement antérieur à la facture, devis et pièces annulées exclus,
  décaissement rapproché d'un avoir et non d'une facture, et deux factures du
  même montant départagées par le nom du client, et la règle qui décide que
  deux libellés désignent la même opération — reconnue quand le court est
  exactement le début du long, refusée dès qu'un doute subsiste.
- **48 tests de bout en bout** — l'application réelle est lancée, pilotée et
  vérifiée : import d'une liste clients en Windows-1252, import du catalogue,
  analyse d'un dossier de PDF, rattachement automatique aux clients, association
  des lignes au stock, déduction puis annulation, idempotence, absence de
  doublons, optimisation avec arrêt épinglé, génération des liens et QR codes,
  exports, navigation dans chaque écran, et reprise automatique d'un fichier
  déposé pendant que le logiciel tourne, rattachement d'une facture dépourvue
  de libellé « Client : », ouverture de chaque fenêtre de saisie, dépôt par
  défaut géolocalisé, repère d'impression, bibliothèque de pièces jointes et
  préparation d'un e-mail depuis les modèles. Côté banque : import d'un relevé
  réel, encaissement rapproché tout seul de la bonne facture (qui passe à
  « réglée »), relevé relu sans le moindre doublon, second relevé chevauchant
  qui n'ajoute que les nouveautés, relevé plus bavard qui complète les libellés
  au lieu de recréer les opérations, ménage des doublons déjà en base fait
  depuis l'écran — revue avant suppression, comptage qui laisse deux lignes à un
  virement survenu deux fois, annotation reprise — et synthèse (totaux,
  catégories, solde).
- **11 tests du mode serveur** — le vrai processus `node dist/server/server.mjs`
  est lancé sur une base temporaire puis interrogé en HTTP comme le ferait un
  navigateur : refus sans jeton, interface web servie, canal inconnu rejeté,
  action de bureau expliquée, création/lecture de client, téléversement d'une
  liste CSV, dépôt d'un PDF détecté par la surveillance avec diffusion SSE,
  téléchargement du PDF d'origine, dépôt d'une facture par téléversement rangée
  sous son nom d'origine et reconnue plutôt que dupliquée, brouillon d'e-mail `.eml` téléchargeable et
  pièce marquée « envoyée », base écrite au bon endroit et arrêt propre sur
  SIGTERM.
- **14 tests de l'application branchée sur le serveur** — le proxy du processus
  principal est exercé tel quel contre un vrai serveur : formes acceptées pour
  l'adresse, liaison enregistrée sur le poste puis relue au démarrage suivant,
  jeton conservé quand seule l'adresse change et effacé au retour en local,
  serveur éteint diagnostiqué sans plantage, mauvais jeton refusé avec un
  message clair, couverture de **tous** les canaux déclarés, écriture depuis le
  poste relue directement sur le serveur, message d'erreur du serveur qui
  traverse le proxy intact, téléversement d'un fichier choisi sur le poste,
  événements du serveur reçus par le poste, PDF rapatrié à l'octet près sous le
  nom qui partira à l'imprimante, facture déposée depuis le poste puis analysée
  sur le serveur, fichier absent expliqué, et repli en local qui ne perd pas la
  liaison enregistrée.
- **13 tests des comptes et des droits** — le jeton partagé continue de faire
  foi tant qu'aucun compte n'existe, la création du premier gérant bascule le
  serveur en connexion obligatoire, ni mot de passe ni jeton de session ne se
  retrouvent en clair dans la base, un livreur atteint ses tournées et lit les
  clients, mais se voit **refuser** banque, documents, stock, cahiers et tableau
  de bord — vérifié sur la réponse du serveur, pas sur l'affichage — il ne peut
  pas davantage récupérer une facture en devinant son identifiant ni téléverser
  un relevé, un identifiant inconnu renvoie le même message qu'un mot de passe
  erroné, une rafale de tentatives verrouille, révoquer une session coupe
  l'accès dans la seconde, et le dernier gérant ne peut ni se rétrograder ni se
  supprimer.
- **11 tests du hors-ligne** — un vrai serveur, un vrai poste (le module
  `offline` tel que l'application l'utilise) et une vraie coupure : le serveur
  est **tué puis relancé** en cours de test. Sont vérifiés : le stock initial
  enregistré comme mouvement, la synchronisation complète puis les deltas, la
  suppression qui descend en pierre tombale, la déduction **déterministe**
  (annuler puis redéduire recrée exactement les mêmes identifiants de
  mouvements), le miroir écrit sur disque, les lectures — y compris soldes de
  stock recalculés — servies pendant la coupure, les écritures muées en
  intentions avec identifiant pré-assigné, le rejeu dans l'ordre au retour du
  serveur avec la fiche recréée **sous le même identifiant**, l'échec métier
  conservé et présenté plutôt qu'avalé, le miroir d'un livreur qui ne reçoit
  jamais banque ni documents, et la restauration de sauvegarde qui change de
  génération et force la resynchronisation complète.
  Enfin le tri des colonnes dans les deux sens sur documents, clients et stock,
  le filtre des relevés sur une période donnée, et la recherche par montant
  qui retrouve une facture par son HT comme par son TTC et une opération
  bancaire par son débit. Deux garde-fous vérifiés en neutralisant volontairement
  le correctif : une relecture ne défait pas les corrections manuelles, et
  déplacer le dossier de travail ne duplique aucun document. Côté cahiers :
  la règle de réservation (une demande ne réserve rien, un devis validé oui,
  une prestation terminée rend ses machines), le refus motivé quand le parc ne
  suit pas, et les messages de notification.
