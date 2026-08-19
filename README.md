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

**La pièce a le dernier mot sur son type.** Vous pouvez désigner des dossiers à
envoyer au serveur en les étiquetant « Factures », « Devis » ou « Avoirs ». Cette
étiquette n'est qu'un **indice** : si le document dit ce qu'il est — par son
titre ou par son nom de fichier —, c'est lui qui l'emporte. Un dossier de devis
déclaré « Factures » d'un clic de trop ne transforme donc pas des centaines de
devis en factures, ce qui gonflerait le chiffre d'affaires et réclamerait des
sorties de stock qu'un devis ne fait jamais. L'étiquette du dossier ne décide
que dans le seul cas où rien n'a pu être lu.

Certains logiciels de facturation impriment le bloc vendeur et le bloc client
côte à côte, sur les mêmes lignes visuelles (« Siret : ...   N° client : ... »).
CompaGelato détecte ce mélange — un code client n'est jamais pris pour un nom,
une ligne d'identification du vendeur (« Siret : … ») intercalée avant le nom du
client est enjambée plutôt que prise pour lui, les libellés de contact du vendeur
(Tél., Port., Email...) qui se glissent dans l'adresse du client sont retirés, et l'appariement des colonnes du tableau
d'articles respecte l'ordre gauche→droite plutôt que la seule position, ce qui
évite qu'une valeur légèrement décalée (alignement à droite) ne tombe dans la
mauvaise colonne. Tout le pavé vendeur n'est pas étiqueté : le nom du gérant,
imprimé seul en bas de la colonne de gauche, se retrouve fusionné avec la ligne
de code postal du client — il est retiré lui aussi, sans quoi il s'invitait dans
l'adresse de tous les clients.

**Une mention du document n'est jamais un nom de client.** Sur les gabarits à
deux colonnes, la ligne « FRANCE » du pavé vendeur fusionne avec le champ
imprimé en face : « FRANCE  Date de livraison : 03/07/2026 », « FRANCE  N° TVA :
NC ». Ces lignes se présentaient comme des noms de clients — et comme elles sont
identiques d'une pièce à l'autre, elles rattachaient des centaines de pièces au
même client. CompaGelato reconnaît désormais leur **forme** — un intitulé suivi
de deux-points, ou une date sur la ligne — plutôt qu'une liste de mentions à
rallonge, qui laissait toujours passer la suivante.

**Le bloc client n'est pas toujours là où on le cherche.** Sur certains
gabarits, « N° client : » est imprimé en haut à droite tandis que le bloc client
arrive bien plus bas : la lecture traverse d'abord toute la colonne du vendeur.
Ses mentions légales sont donc écartées — une ligne de pays seule, une mention
propre au document (« Devis valable jusqu'au… », « Date et signature »,
« Acompte demandé… ») ne peut pas être un nom de client. Le garde-fou reste
étroit : « FRANCE BOISSONS » est une entreprise bien réelle et continue d'être
acceptée.

**Un mauvais rattachement ne survit pas à une lecture qui dit autre chose.**
Quand la relecture lit un nom de client différent de celui qui avait servi à
rattacher la pièce, l'ancien lien n'est pas conservé : il reposait sur une
lecture désormais corrigée, et le garder figerait l'erreur pour toujours. Le
lien ne tient que si la lecture est identique — c'est le cas d'une fiche
simplement renommée, où recréer une fiche au nom lu fabriquerait un doublon.

**Réparer les rattachements hérités.** Les orthographes apprises
automatiquement avant cette correction gardent leur pouvoir : une pièce dont le
nom est pourtant lu correctement peut encore repartir vers la mauvaise fiche,
avec un score de 0,97 et sans le moindre signe — il suffit que cette chaîne
dorme dans les orthographes de cette fiche. On ne peut pas distinguer après
coup ce qui a été appris tout seul de ce que vous avez confirmé, d'où un geste
explicite : **Réglages → Réparer les rattachements clients → Oublier les
orthographes apprises**, puis **Documents → Tout relire**. Vos fiches, vos
pièces et vos rattachements corrigés à la main ne sont pas touchés.

**Votre entreprise n'est jamais son propre client.** Sur une facture que vous
**recevez** — un transporteur, un fournisseur —, le bloc « client » porte VOS
coordonnées : votre nom, votre SIRET. Ces pièces se rattachaient donc à la fiche
de votre base qui portait ce SIRET, avec un rapprochement à 100 %, alors que
rien dans le document ne désigne ce client-là. Renseignez le **SIRET de votre
entreprise** dans Réglages : une pièce dont le client est vous-même est
reconnue comme reçue, signalée comme telle, et n'est rattachée à personne.

**Un nom non reconnu n'est jamais rattaché au jugé.** Une pièce n'est reliée à
un client que sur une certitude : même SIRET, même nom, ou une orthographe que
vous avez vous-même confirmée. Quand le nom lu ne correspond à rien, la pièce
reste **sans client** — visible, corrigeable en un clic — et le voisin le plus
proche n'est qu'une piste écrite dans les avertissements. Rattacher « au plus
proche » attribuait des dizaines de pièces à un client vu deux fois dans
l'année, sans que rien ne permette de s'en apercevoir.

**Un rapprochement par ressemblance reste une hypothèse.** Quand une pièce est
rattachée à un client par ressemblance, l'orthographe lue n'est plus mémorisée
dans la fiche. Elle l'était, et cela transformait une supposition en certitude :
l'alias servait ensuite lui-même de point de comparaison, si bien qu'une
première erreur en attirait des dizaines d'autres — toutes vers le même client,
sans que rien ne le signale. Seule votre confirmation (corriger le client sur
une pièce) apprend une orthographe. Les alias devenus douteux sont ignorés au
rapprochement — y compris ceux qui portent le nom d'une **autre** fiche, signe
qu'un rapprochement automatique a inscrit un client dans le carnet d'un autre :
une fiche déjà salie se répare toute seule à la relecture.

**Un interlocuteur n'est pas une adresse.** Certains logiciels de facturation
obligent à choisir entre une raison sociale et un nom de personne : facturer une
association ou une mairie en gardant le nom du contact impose alors de le ranger
dans la première ligne d'adresse. CompaGelato le reconnaît et le range dans le
champ **Contact** de la fiche, l'adresse postale restant propre. Le repère est
étroit — ligne sans chiffre, suivie d'un numéro de voie — et dans le doute la
ligne reste dans l'adresse : un contact manqué se rattrape, une adresse amputée
non.

Les fichiers d'origine ne sont **jamais** modifiés ni déplacés. Un fichier déjà
importé et inchangé est ignoré : rescanner ne crée pas de doublon.

**Les factures brouillon ne comptent pas deux fois.** Beaucoup d'entreprises
émettent une facture brouillon en lieu et place d'un proforma : elle sert à
réclamer le règlement sans avancer la TVA, et la facture définitive suit
toujours. CompaGelato reconnaît ces pièces — au titre (« FACTURE BROUILLON »,
« PROVISOIRE ») comme au préfixe du numéro (MEG émet `BRO00001041`, puis la
`FAC` correspondante) — et les enregistre au statut **Brouillon** : elles
n'entrent pas dans le chiffre d'affaires, ne sortent rien du stock et
n'apparaissent pas dans les pièces « en attente ». Quand la facture définitive
arrive, c'est elle qui compte, une seule fois. Vous gardez la main : changer le
statut à la main sur une pièce précise l'emporte sur le lecteur, et une pièce
dont le stock est déjà sorti garde le sien — le mouvement, lui, a bien eu lieu.

Si des brouillons avaient été importés avant que le lecteur ne sache les
reconnaître, **Documents → Tout relire** les rattrape : la relecture recalcule
le statut des pièces que vous n'avez pas modifiées vous-même.

**« Analyser le dossier » ne suffit pas dans ce cas**, et c'est voulu : il saute
les fichiers inchangés, ce qui rend le passage quotidien instantané. Mais quand
c'est le *lecteur* qui a progressé — et non les fichiers —, plus rien ne
viendrait corriger les pièces déjà en base. **Tout relire** les reprend toutes,
même inchangées. Vos corrections manuelles, vos repères d'impression et d'envoi
et les quantités déjà déduites sont conservés.

**Le cas d'une location, reprises comprises.** Vous partez avec une machine et
dix cartons de mix, la brouillon annonce 1 200 €. Au retour, trois cartons
reviennent : la facture définitive tombe à 900 €. Les deux pièces portent des
numéros différents, ce sont donc deux documents distincts — la brouillon reste
visible au statut Brouillon (pratique pour savoir ce qui est parti), et seule la
définitive compte : **900 € de chiffre d'affaires, sept cartons sortis du
stock**. Vous n'avez aucune reprise à saisir nulle part : la facture définitive
est déjà le net, c'est elle qui fait foi.

Un cas seulement demande votre attention, et le logiciel vous le signale : une
pièce **relue sous le même numéro** avec un montant différent **après** que son
stock a été déduit. Les quantités déduites restent alors celles de la version
précédente — l'avertissement vous dit de quel montant à quel montant, et il
suffit d'annuler la déduction puis de la refaire.

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

**Notifications sur le poste**
Quand quelqu'un d'autre ajoute quelque chose — une écriture dans un cahier, une
facture, un relevé, une tâche —, une notification du système apparaît sur votre
ordinateur : bulle Windows, centre de notifications macOS. Un clic ouvre la page
concernée.

**Jamais pour vos propres gestes.** Le serveur annonce chaque arrivée en
nommant son auteur ; votre poste écarte ce que vous avez fait vous-même. C'est
la condition pour que ces notifications restent utiles : celle qui répète ce
qu'on vient de taper finit par être coupée, et c'est celle qui comptait qu'on
rate ensuite. Une arrivée sans auteur — un fichier déposé directement dans le
dossier du serveur — est en revanche annoncée à tout le monde, puisque c'est
justement ce qu'on veut apprendre.

Trois autres garde-fous : rien ne s'affiche quand la fenêtre CompaGelato est
déjà sous vos yeux (réglable), un import de trois cents pièces fait **une**
notification et non trois cents, et une relecture forcée n'annonce rien —
elle repasse sur ce qui était déjà là. Chaque source se coupe séparément dans
**Réglages → Notifications sur ce poste**.

Ces notifications n'existent qu'en mode branché sur le serveur : sur une base
locale, il n'y a personne d'autre pour ajouter quoi que ce soit. Elles ne
remplacent pas les notifications sur téléphone (ntfy), qui restent le moyen de
prévenir quelqu'un qui n'est pas devant un ordinateur.

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

**Tâches : le suivi des clients et du quotidien**
Un onglet pour noter ce qui doit être fait — relancer un client, rappeler un
SAV, envoyer un papier — sans que rien ne se perde jamais. Trois promesses,
chacune vérifiée par un test :

- **L'urgent d'abord.** Quatre priorités (urgent, haute, normale, basse), pas
  davantage : au-delà, plus personne ne sait ce qui distingue un « P2 » d'un
  « P3 » et tout finit urgent. La liste se trie toute seule : priorité, puis
  échéance la plus proche. Une échéance passée s'affiche **en retard**, en
  rouge.
- **Rien ne se perd.** « Supprimer » met à la **corbeille**, d'où l'on
  restaure d'un clic pendant trente jours — le clic malheureux n'est plus une
  perte. Chaque tâche porte son **journal** : qui a changé quoi, quand, en
  clair (« priorité Normale → Urgent », « statut Fait → À faire »). Marquer
  fait par erreur se défait d'un geste, la date de réalisation suit.
- **L'équipe est prévenue.** L'ajout d'une tâche déclenche une bulle Windows
  sur les autres postes branchés (jamais chez son auteur — être prévenu de sa
  propre saisie n'apprend rien) et, si le sujet ntfy est configuré, une
  notification sur les téléphones. Cliquer sur la bulle ouvre l'onglet Tâches.

Une tâche se **rattache à un client** (fiche existante, créée en un clic, ou
simple nom noté au vol — même sélecteur que les cahiers) et peut être
**confiée** à un membre de l'équipe. Hors ligne, tout continue : créer,
modifier, jeter, restaurer partent en file d'attente et se rejouent au retour
du serveur, comme le reste.

**Le serveur se met à jour tout seul**
Les postes se mettent à jour d'un bouton, sous les yeux de quelqu'un ; le
serveur, lui, restait en arrière jusqu'à ce qu'on aille ouvrir un navigateur
sur sa propre machine. Il le fait désormais **chaque nuit vers 3 h**, avec une
sauvegarde prise juste avant de basculer. Trois garde-fous : il s'abstient
complètement si rien ne le relancerait (sans quoi une mise à jour l'éteindrait
et il faudrait se déplacer), il cesse d'insister après trois échecs sur la même
version, et il n'agit qu'une fois par jour même s'il redémarre entre-temps. Un
bouton **Réglages → Mise à jour du serveur** permet de ne pas attendre la nuit.

**Un écran ne tourne jamais dans le vide**
Un chargement qui échoue le dit, au lieu d'afficher une attente sans fin ou —
pire — une liste vide qui ressemble à « rien à faire ». Le cas le plus
fréquent est nommé : quand un poste demande une fonction que le serveur ne
connaît pas encore, l'écran affiche **« Le serveur n'est pas à jour »** et non
un code technique. Les deux versions se comparent dans Réglages → À propos.

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

**Chaque machine se met à jour de son côté.** Le serveur et chaque poste
exécutent *leur* copie du logiciel : le serveur ne descend que des données, pas
du code. Mettre le serveur à jour ne change donc rien à ce que montre un poste,
et inversement — chercher la nouveauté sur la mauvaise machine, c'est chercher
quelque chose qui ne peut pas apparaître.

Le bouton est le même partout, seule l'adresse change :

| Machine | Où cliquer |
|---|---|
| Un poste de bureau | Réglages → Mises à jour, **sur ce poste** |
| Le serveur | son adresse dans un navigateur (`http://oldpc:4680`), puis le même bouton |

Le serveur n'a pas besoin de SSH : il expose les mêmes canaux, se reconstruit
seul, puis quitte — systemd le relance aussitôt. Quand un poste est branché,
**À propos** affiche les deux commits côte à côte et signale l'écart, pour que
personne n'ait à le deviner.

**Quelle version tourne ici ?** Le numéro affiché dans **Réglages → À propos**
(`1.0.0`) ne bouge pas d'une mise à jour à l'autre : il ne dit rien de l'état
réel du poste. La ligne à côté, `a1b2c3d · 2026-08-07`, est le commit d'où
tourne cette copie — c'est elle qui permet de dire si un poste a bien pris la
dernière mise à jour, et de comparer deux machines entre elles. Sur un poste
branché, c'est le commit **du poste**, celui du code exécuté sous vos yeux ;
celui du serveur se lit sur le serveur.

---

## Où sont mes données

Un unique fichier JSON dans le dossier de profil de l'application :

| Système | Emplacement |
|---|---|
| Windows | `%APPDATA%\CompaGelato\compagelato-data.json` |
| macOS | `~/Library/Application Support/CompaGelato/` |
| Linux | `~/.config/CompaGelato/` |

Les écritures sont atomiques (fichier temporaire puis renommage) : une coupure
de courant ne peut pas corrompre la base. Les sauvegardes sont conservées dans
le sous-dossier `backups`, et une base illisible est automatiquement remplacée
par la dernière sauvegarde valide.

Réglages → Données permet de sauvegarder, restaurer et exporter à tout moment.

### Les sauvegardes se font toutes seules

Une sauvegarde qu'il faut penser à déclencher n'en est pas une : le jour où elle
compte est justement celui où on a oublié d'appuyer. La machine qui détient les
données — le serveur en mode multi-postes, le poste lui-même en mode autonome —
sauvegarde donc **au démarrage puis toutes les 24 heures**, et garde les
**30 dernières**.

Deux détails font toute la valeur du dispositif :

- **Une base inchangée n'est pas réécrite.** Le nombre de sauvegardes est borné ;
  en écrire une identique à chaque passage chasserait du dossier les versions
  anciennes — précisément celles qui servent quand une erreur est remarquée avec
  des jours de retard. Une semaine sans saisie ne consomme donc aucune place.
- **Ce qui est recopié ailleurs se rattrape.** Un disque externe débranché mardi
  reçoit sa copie mercredi, sans attendre la prochaine facture saisie.

Sur le serveur, `COMPAGELATO_BACKUP_COPY` fait suivre chaque sauvegarde vers un
ou plusieurs dossiers supplémentaires — disque externe, partage réseau, dossier
synchronisé. Un support absent est signalé au journal et n'interrompt jamais ni
la sauvegarde locale, ni le serveur.

### Chaque poste garde sa propre copie du serveur

Le miroir hors-ligne permet de **travailler** sans le serveur, mais ce n'est pas
une sauvegarde : il est filtré par le rôle de l'utilisateur, rangé dans un format
interne, et rien ne permettrait de le restaurer. Si le disque du serveur lâchait,
les postes continueraient d'afficher les données sans qu'on puisse les remettre
en place nulle part.

Un poste branché rapatrie donc, **toutes les 24 heures et sans rien demander à
personne**, la base entière du serveur dans son propre dossier de profil :

```
<dossier de profil>/sauvegardes-serveur/backup-<horodatage>.json
```

Quatorze copies y sont conservées, et l'une d'elles se restaure depuis
Réglages → Données comme n'importe quelle sauvegarde. Les données existent alors
sur deux machines sans que personne ait eu à y penser. Un serveur éteint ou une
session pas encore ouverte ne sont pas des incidents : le poste réessaie au
passage suivant.

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
| `COMPAGELATO_BACKUP_HOURS` | Heures entre deux sauvegardes automatiques (`0` = désactivé) | `24` |
| `COMPAGELATO_BACKUP_KEEP` | Sauvegardes conservées | `30` |
| `COMPAGELATO_BACKUP_COPY` | Dossiers de recopie, séparés par `;` | *(aucun)* |
| `COMPAGELATO_UPDATE_HOUR` | Heure du passage de mise à jour automatique (`-1` = jamais) | `3` |

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
- La **mise à jour** depuis l'écran Réglages met à jour **ce poste** : c'est son
  code qui s'exécute sous vos yeux, et « Redémarrer maintenant » relance bien
  cette application-ci. Elle fonctionne même serveur éteint — un `git pull` n'a
  que faire du serveur. Le serveur se met à jour de son côté (voir plus bas) :
  le processus en cours garde de toute façon son code en mémoire jusqu'au
  redémarrage du service.
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
  RestartSec=2

  [Install]
  WantedBy=multi-user.target
  ```

  puis `systemctl enable --now compagelato`.

  **`Restart=always` n'est pas décoratif** : c'est lui qui autorise le serveur
  à se mettre à jour tout seul. Sans cette ligne, redémarrer reviendrait à
  éteindre — il faudrait aller sur place — et le serveur refuse alors de le
  faire, en le disant au démarrage comme à l'écran.

  **Le serveur se met à jour de lui-même, chaque nuit vers 3 h** (réglable par
  `COMPAGELATO_UPDATE_HOUR`, `-1` pour ne jamais le faire). Il prend une
  sauvegarde juste avant de basculer, puis redémarre. Si une version échoue
  trois fois de suite, il cesse d'insister et le journal le dit : un serveur
  qui se relance en boucle toute la nuit serait pire que le retard.

  Pour ne pas attendre la nuit — typiquement le jour où un poste vient de
  prendre une nouveauté que le serveur ne connaît pas encore —, l'application
  de bureau branchée offre **Réglages → Mise à jour du serveur**. Attention à
  ne pas confondre avec la carte **Mises à jour** juste au-dessus, qui met à
  jour *le poste* : chaque machine exécute sa propre copie du logiciel.
- Pour l'accès **hors du réseau local** (tournées, télétravail), installez
  [Tailscale](https://tailscale.com) sur le serveur et sur vos appareils :
  l'adresse `http://<nom-tailscale>:4680` marche alors de partout, chiffrée,
  sans ouvrir le moindre port sur la box.

### Faire monter des données existantes sur le serveur

Le serveur démarre vide. Si un poste travaille déjà depuis un moment, ses
données montent en trois gestes — dans cet ordre.

1. **Sur le poste qui détient les données, encore en local** : Réglages →
   Données → **Sauvegarder**. Notez le chemin du fichier `.json` annoncé.
2. **Copiez le contenu du dossier surveillé** (`Factures/`, `Devis/`,
   `Clients/`, `Pieces-jointes/`…) dans le dossier surveillé du serveur. La
   base ne contient que les *chemins* des pièces, enregistrés relativement à ce
   dossier : sans les fichiers, les PDF resteraient introuvables.
3. **Branchez ce poste sur le serveur** (Réglages → Serveur, adresse, puis
   redémarrage), puis Réglages → Données → **Restaurer…** et désignez la
   sauvegarde de l'étape 1. Elle part au serveur et remplace sa base.

Les dossiers enregistrés dans la sauvegarde sont ceux du poste d'origine. Un
`C:\Users\…\CompaGelato` restauré sur un serveur Linux ne désignerait rien :
CompaGelato le remplace donc par le dossier par défaut de la machine d'accueil,
et le dossier des relevés retombe sur `<dossier de travail>/Releves`. Les
chemins des pièces, eux, sont relatifs et n'ont pas à changer.

La restauration change la **génération** de la base : chaque appareil déjà
synchronisé repart d'une copie complète à sa prochaine connexion. C'est voulu —
sans cela, les fiches supprimées depuis la sauvegarde ressusciteraient sans que
personne s'en aperçoive.

Les autres postes n'ont alors plus qu'à être branchés à leur tour (Réglages →
Serveur). Un poste branché n'utilise plus sa base locale : elle reste sur son
disque, intacte, mais n'est plus lue.

### Les dossiers du poste montent tout seuls

En mode branché, c'est le serveur qui surveille **son** dossier. Or le logiciel
de comptabilité écrit ses PDF sur le **poste**, souvent dans un autre bâtiment :
il fallait donc ouvrir l'application et désigner les fichiers un à un, à chaque
export. Un partage réseau ne résout rien dès que les deux machines ne sont pas
sur le même réseau — et exposer un partage de fichiers sur Internet n'est pas
une option.

Le poste surveille donc **ses propres dossiers** et envoie au serveur ce qui y
arrive. Le réglage vit sur la page où l'on s'en sert :

| Page | Ce qu'on y désigne |
|---|---|
| **Documents** | les dossiers de factures, devis et avoirs |
| **Banque** | le dossier des relevés exportés par la banque |

Désigner un dossier envoie d'abord ce qui s'y trouve déjà, puis tout nouveau
fichier. Le type choisi voyage avec la pièce : un fichier venu du dossier
« Factures » du poste est rangé dans `Factures` côté serveur, au lieu d'être
redeviné puis posé en vrac. Ça marche par l'adresse Funnel comme par Tailscale
— donc depuis le travail comme de chez soi, sans VPN ni partage réseau.

Trois garanties, et ce sont elles que les tests visent :

- **Aucun fichier perdu.** Un envoi n'est retenu comme fait qu'une fois le
  serveur d'accord. Coupure, serveur éteint, session expirée : le fichier reste
  à envoyer et repart au passage suivant.
- **Aucun envoi en boucle.** Ce qui est parti est mémorisé. Et comme le serveur
  compare les contenus avant de ranger, un envoi en trop ne crée jamais de
  doublon — la mémoire est une économie, pas une garantie fragile.
- **Aucun fichier touché.** On lit, on envoie. Rien n'est déplacé, renommé ni
  supprimé : le dossier de comptabilité reste tel que son propriétaire l'a rangé.

La liste appartient à l'appareil, comme l'adresse du serveur : `D:\Compta` n'a
aucun sens sur le téléphone du livreur. Elle vit dans `dossiers.json`, à côté de
`connexion.json`, et ne se synchronise jamais.

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

Pour démarrer : **Réglages → Comptes → Ajouter**. Tant qu'aucun compte n'existe,
la carte est visible de tous — elle ne saurait exiger une identité de gérant
alors qu'elle est justement le seul endroit où en créer une. Le premier compte
créé est gérant, et vous serez invité à vous connecter au rechargement suivant.

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

### Donner l'app à quelqu'un d'extérieur au réseau

Un associé, un patron, un comptable : quelqu'un doit avoir une application qui
marche, sans pour autant rejoindre le réseau privé où vivent vos machines. Un
VPN classique — ou un tailnet Tailscale laissé en configuration par défaut — est
**plat** : l'appareil invité peut joindre le NAS, les PC, les téléphones. Ce
n'est pas ce qu'on veut ici, et ce n'est pas nécessaire.

**Tailscale Funnel** publie le seul port de CompaGelato, en HTTPS, sans rien
ouvrir sur la box :

Trois gestes, dans cet ordre — les deux premiers ne se font qu'une fois :

```bash
# 1. Autoriser Funnel sur le tailnet. La commande refuse tant que ce n'est pas
#    fait, en affichant le lien d'activation à ouvrir dans la console d'admin.
#    (« Funnel is not enabled on your tailnet. To enable, visit: … »)

# 2. Se donner le droit de piloter Tailscale sans sudo, une bonne fois.
#    Sans cela : « Access denied: serve config denied ».
sudo tailscale set --operator=$USER

# 3. Publier le port. `--bg` est indispensable sur un serveur : sans lui, la
#    commande occupe le terminal et la publication s'arrête à sa fermeture.
tailscale funnel --bg 4680
```

Vous obtenez une adresse du type `https://oldpc.votre-tailnet.ts.net`. La
personne la saisit dans l'application mobile ou l'ouvre dans son navigateur, et
c'est tout : rien à installer de plus, aucun compte Tailscale, aucun accès à
votre réseau.

`tailscale funnel status` indique ce qui est publié, `tailscale funnel --bg off`
coupe la publication. Si Tailscale se plaint du certificat, activez HTTPS
(MagicDNS et certificats) dans la console d'admin : Funnel en a besoin pour
terminer le TLS à votre place.

Le sens du flux compte autant que le chiffrement : **son téléphone appelle le
serveur, jamais l'inverse.** Il n'existe aucune route depuis oldpc vers son
appareil ou son réseau — ni pour vous, ni pour le logiciel. Et le serveur ne
conserve pas d'où il se connecte : une session n'enregistre que le nom de
l'appareil, les dates et l'empreinte du jeton (voir `Session` dans
`shared/types.ts`). L'adresse IP ne sert qu'en mémoire vive à compter les
tentatives ratées, et disparaît au redémarrage.

Ce qui protège les données, une fois l'adresse publiée, c'est la connexion :
mots de passe **scrypt**, **8 tentatives puis 15 minutes de blocage** par compte
et par appareil, sessions opaques et révocables. Dès qu'un compte existe, le
jeton partagé ne donne plus accès — seule une session ouverte compte.

Deux précautions, dans cet ordre d'importance :

- **Créez-lui un compte Bureau, pas Gérant.** Il aura une application
  pleinement fonctionnelle — clients, documents, stock, cahiers, banque, tableau
  de bord, tournées — mais ne pourra ni télécharger la base entière
  (`GET /files/backup` et `db:backup` sont réservés au gérant), ni gérer les
  comptes, ni changer les réglages, ni mettre le serveur à jour. Le contrôle est
  fait par le serveur, pas par l'affichage.
- **Ne redirigez jamais le port 4680 depuis votre box.** Le serveur parle HTTP
  en clair : son mot de passe traverserait Internet en clair. Funnel termine le
  TLS pour vous, c'est précisément ce qui rend l'exposition acceptable.

> Variante plus fermée, si la personne accepte d'installer Tailscale : partagez
> le **seul nœud** `oldpc` avec son compte (*node sharing*). Son appareil reste
> sur son propre tailnet, vos machines lui sont invisibles, et rien n'est publié
> sur Internet. Une règle d'accès limite le partage au port de l'app :
>
> ```jsonc
> "grants": [
>   { "src": ["autogroup:shared"], "dst": ["oldpc"], "ip": ["tcp:4680"] }
> ]
> ```

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

### Développer (iPhone ou Android, Expo Go)

```bash
cd mobile
npm install
npm start
```

Scannez le QR code avec Expo Go. Le serveur de dev et le téléphone doivent
être sur le même réseau (ou le tailnet) ; sinon `npm run tunnel`, plus lent
mais indifférent au réseau.

**Le port de développement est 7879**, et non le 8081 par défaut de Metro :
celui-ci est très demandé, et le trouver occupé par un autre projet arrête le
démarrage sans que la cause saute aux yeux. Il est inscrit dans les scripts de
`mobile/package.json` — d'où `npm start` plutôt que `npx expo start`, qui
reprendrait le 8081.

### Tester dans l'émulateur Android (PC Windows)

Utile quand on n'a pas de téléphone Android sous la main. Une fois Android
Studio installé, créez un appareil virtuel (*Device Manager* → *Create
Device*), démarrez-le, puis rendez `adb` visible pour Expo — dans PowerShell :

```powershell
[Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
$p = [Environment]::GetEnvironmentVariable("PATH", "User")
[Environment]::SetEnvironmentVariable("PATH", "$p;$env:LOCALAPPDATA\Android\Sdk\platform-tools", "User")
```

Rouvrez PowerShell, vérifiez avec `adb devices` que l'émulateur répond
`device` (et non `offline`, qui signifie « démarrage en cours »), puis
`npm start` et la touche `a`.

Deux pièges de l'émulateur : il sort par le réseau du PC, donc l'adresse
Tailscale du serveur ne marche que si **Tailscale tourne sur le PC** ; et
`localhost` y désigne l'émulateur lui-même, jamais la machine hôte.

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
  folders.ts              Dossiers du poste à surveiller (propre à l'appareil)
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
    autoBackup.ts         Sauvegardes automatiques : rien à réécrire quand la
                          base n'a pas bougé, recopie qui se rattrape
    serverBackup.ts       La copie du serveur que chaque poste rapatrie chez lui
    uploadWatcher.ts      Les dossiers du poste surveillés et envoyés au serveur
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

**La chaîne d'import a été passée en relecture croisée** (10/08/2026) : trois
relecteurs indépendants — lecture des pièces, ingestion en base, transport
poste → serveur — chacun tenu de démontrer ses constats par un scénario
exécuté, puis un contre-vérificateur chargé de les réfuter. 24 constats
confirmés, tous corrigés, chacun figé par un test de non-régression
(tests/audit.test.mjs, 23 tests) : parmi eux, un journal CSV de N pièces
réduit à une seule, un fichier refusé pour session expirée marqué « envoyé »
donc perdu, une facture d'acompte citant son devis typée devis, « NET À
PAYER 0,00 € » écrasant le vrai total TTC, le SIRET du vendeur pris pour
celui du client sur toute facture multipage, et un scanner réécrivant
« scan.pdf » qui effaçait la pièce du mois précédent. Limitation connue et
assumée : un fichier monté au serveur sous une mauvaise étiquette reste
rangé dans le sous-dossier de l'étiquette (le type en base, lui, est le bon,
et les copies en double n'oscillent plus).

- **239 tests unitaires** — lecture de nombres et dates français, CSV avec
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
  été modifiés) validé sur un vrai dépôt temporaire — dont le commit annoncé
  par « À propos », qui doit **changer** quand le dépôt reçoit un commit de
  plus : c'est toute son utilité, puisque le numéro de version, lui, ne bouge
  jamais.
- **7 de ces tests portent sur le bloc client d'un devis** — le gabarit où
  « N° client : » est loin du client, et où la ligne pays du vendeur fusionnée
  avec la validité du devis passait pour un nom. Sont vérifiés le nom
  effectivement retenu, l'interlocuteur rangé en contact, le client nommé sans
  raison sociale, les mentions du document rejetées, « FRANCE BOISSONS »
  acceptée, et l'emballement des alias : un alias douteux n'attire plus les
  pièces et n'est plus mémorisé.
- **5 de ces tests portent sur le type de la pièce** — non pas « sait-on lire
  DEVIS », mais « sait-on qu'on l'a lu » : c'est cette certitude qui décide si
  le classement d'un dossier peut contredire le document. Sont vérifiés le
  titre, le nom de fichier d'un logiciel de facturation (« DEV00000622 »
  devient « dev 00000622 » une fois normalisé — sans tolérer cette séparation,
  le repli ne se déclenchait jamais), le document illisible qui l'admet, et
  « developpement-2026.pdf » qui n'est pas un devis.
- **15 de ces tests portent sur les notifications du poste** — parce que la
  règle qui les rend supportables est aussi celle qu'on casse sans s'en
  apercevoir : ne jamais notifier l'auteur de son propre geste. Sont vérifiés
  ce filtre et ses deux limites (une arrivée sans auteur passe, et un poste qui
  n'a pas encore lu son identité ne se croit pas l'auteur de tout), la coupure
  par source, le silence quand la fenêtre est au premier plan, le défaut
  utilisable sans rien régler, la mémoire bornée qui empêche un serveur
  redémarré de rejouer ses annonces, et le regroupement d'un import massif en
  une seule annonce. Une annonce qui échoue ne fait jamais échouer
  l'enregistrement qui l'a déclenchée.
- **14 de ces tests portent sur les factures brouillon** — parce que l'erreur
  qu'ils empêchent est silencieuse : une pièce provisoire comptée comme
  définitive gonfle le chiffre d'affaires et vide le stock une fois de trop,
  sans que rien ne le signale. Sont vérifiés la reconnaissance au titre comme
  au préfixe du numéro (et son garde-fou : `BROCHURE-2026` n'est pas un
  brouillon), un vrai PDF brouillon lu avec ses totaux intacts, l'exclusion du
  chiffre d'affaires, du stock appliqué en masse et du compteur « en attente »,
  la relecture qui rattrape une pièce importée avant que le lecteur ne sache la
  reconnaître, et le statut choisi à la main qui tient bon face au lecteur.
  Trois portent sur l'écart qu'on ne voyait pas : une pièce dont le montant
  change **après** la déduction du stock garde ses quantités déduites, et doit
  donc le dire — mais se taire quand le montant n'a pas bougé, et quand le
  total a été fixé à la main.
- **6 de ces tests portent sur le bloc client d'une facture réelle** — pavé
  vendeur et pavé client fusionnés colonne à colonne : la raison sociale
  retenue comme nom plutôt que l'interlocuteur, l'interlocuteur sorti de
  l'adresse postale et rangé en contact, le gérant du vendeur qui ne s'invite
  pas dans l'adresse du client, le téléphone et l'e-mail qui restent ceux du
  client — et les deux garde-fous : un client sans interlocuteur garde son
  adresse entière, et une ligne d'adresse sans numéro de voie (« Place du
  Marché ») n'est jamais prise pour un contact.
- **13 de ces tests portent sur les sauvegardes automatiques** — et visent
  surtout ce qui rend une sauvegarde automatique digne de confiance plutôt que
  le fait qu'elle ait lieu : une base inchangée n'est pas réécrite (sans quoi
  l'historique qu'on demande de garder serait chassé par des copies identiques),
  le fichier d'état ne se retrouve pas dans la liste proposée à la restauration,
  la rotation ne supprime que ses propres fichiers — le dossier de copie peut
  être une clé USB pleine d'autre chose —, une clé débranchée puis rebranchée
  vide reçoit sa copie sans attendre la prochaine modification, un dossier de
  copie injoignable n'empêche pas la sauvegarde locale et rapporte sa raison,
  le planificateur sauvegarde dès son démarrage, une valeur de configuration
  illisible retombe sur le défaut qui protège plutôt que sur « ne rien
  sauvegarder », et une réponse qui n'est pas une base — page d'erreur, refus
  d'accès — n'est jamais rangée sous un nom de sauvegarde.
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
- **12 tests du mode serveur** — le vrai processus `node dist/server/server.mjs`
  est lancé sur une base temporaire puis interrogé en HTTP comme le ferait un
  navigateur : refus sans jeton, interface web servie, canal inconnu rejeté,
  action de bureau expliquée, création/lecture de client, téléversement d'une
  liste CSV, dépôt d'un PDF détecté par la surveillance avec diffusion SSE,
  téléchargement du PDF d'origine, dépôt d'une facture par téléversement rangée
  sous son nom d'origine et reconnue plutôt que dupliquée, brouillon d'e-mail `.eml` téléchargeable et
  pièce marquée « envoyée », copie de la base téléchargeable par un gérant mais
  fermée sans jeton, base écrite au bon endroit et arrêt propre sur
  SIGTERM.
- **17 tests de l'application branchée sur le serveur** — le proxy du processus
  principal est exercé tel quel contre un vrai serveur : formes acceptées pour
  l'adresse, liaison enregistrée sur le poste puis relue au démarrage suivant,
  jeton conservé quand seule l'adresse change et effacé au retour en local,
  serveur éteint diagnostiqué sans plantage, mauvais jeton refusé avec un
  message clair, couverture de **tous** les canaux déclarés, écriture depuis le
  poste relue directement sur le serveur, message d'erreur du serveur qui
  traverse le proxy intact, téléversement d'un fichier choisi sur le poste,
  événements du serveur reçus par le poste, PDF rapatrié à l'octet près sous le
  nom qui partira à l'imprimante, facture déposée depuis le poste puis analysée
  sur le serveur, fichier absent expliqué, copie de sécurité rapatriée par le
  poste — écrite la première fois, ignorée tant que le serveur n'a pas bougé,
  reprise dès qu'une fiche y est saisie —, dossiers du poste surveillés et
  envoyés (pièce rangée dans le sous-dossier de son type, jamais renvoyée deux
  fois, fichier d'origine intact, et surtout : serveur injoignable, rien n'est
  marqué envoyé, tout repart au retour), et repli en local qui ne perd pas la
  liaison enregistrée.
- **14 tests des comptes et des droits** — le jeton partagé continue de faire
  foi tant qu'aucun compte n'existe, la création du premier gérant bascule le
  serveur en connexion obligatoire, ni mot de passe ni jeton de session ne se
  retrouvent en clair dans la base, un livreur atteint ses tournées et lit les
  clients, mais se voit **refuser** banque, documents, stock, cahiers et tableau
  de bord — vérifié sur la réponse du serveur, pas sur l'affichage — il ne peut
  pas davantage récupérer une facture en devinant son identifiant ni téléverser
  un relevé, un identifiant inconnu renvoie le même message qu'un mot de passe
  erroné, une rafale de tentatives verrouille, révoquer une session coupe
  l'accès dans la seconde, et le dernier gérant ne peut ni se rétrograder ni se
  supprimer. Une arrivée annoncée sur le flux d'événements porte l'identifiant
  de son auteur — c'est ce qui permet à chaque poste d'écarter ses propres
  gestes, et cela se vérifie contre un vrai serveur, pas en théorie.
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
- **2 tests de la reprise d'une base venue d'ailleurs** — la sauvegarde d'un
  poste Windows est réellement restaurée sur cette machine : les données
  arrivent, mais le dossier de travail redevient celui d'ici et le dossier des
  relevés retombe sur son défaut, tandis que les chemins des pièces restent
  relatifs. Garde-fou vérifié en neutralisant le correctif — le
  `C:\Users\…` était conservé tel quel.
- **2 tests de la mise à jour d'un poste branché** — l'application est lancée
  pour de bon en mode connecté contre un vrai serveur, puis le serveur est tué.
  L'analyse de dossier réclame alors le serveur, comme elle le doit, tandis que
  « Rechercher les mises à jour » répond quand même : c'est le dépôt de ce
  poste qu'elle interroge. Garde-fou vérifié en neutralisant volontairement le
  correctif — les deux canaux repartaient au serveur et le bouton refusait de
  s'exécuter.
  Enfin le tri des colonnes dans les deux sens sur documents, clients et stock,
  le filtre des relevés sur une période donnée, et la recherche par montant
  qui retrouve une facture par son HT comme par son TTC et une opération
  bancaire par son débit. Deux garde-fous vérifiés en neutralisant volontairement
  le correctif : une relecture ne défait pas les corrections manuelles, et
  déplacer le dossier de travail ne duplique aucun document. Côté cahiers :
  la règle de réservation (une demande ne réserve rien, un devis validé oui,
  une prestation terminée rend ses machines), le refus motivé quand le parc ne
  suit pas, et les messages de notification.
