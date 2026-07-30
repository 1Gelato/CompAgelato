# CompaGelato

Logiciel de gestion pour ordinateur (Windows, macOS, Linux). Il ne remplace pas
votre logiciel de comptabilité : il **lit** les factures et devis que celui-ci
produit, les range dans des tableaux, tient votre stock de consommables à jour
et calcule vos tournées de livraison.

Tout reste sur votre machine. Aucun compte, aucun serveur, aucun abonnement.

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

Les fichiers d'origine ne sont **jamais** modifiés ni déplacés. Un fichier déjà
importé et inchangé est ignoré : rescanner ne crée pas de doublon.

**Carnet de clients**
Import de votre liste depuis CSV ou Excel, avec reconnaissance automatique des
colonnes (nom, adresse, code postal, e-mail, SIRET…). Les factures se rattachent
seules à la bonne fiche — par SIRET, par nom exact, puis par ressemblance. Quand
vous corrigez un rattachement, le nom lu sur la facture est mémorisé : la fois
suivante, c'est automatique.

**Stock de consommables**
Vous saisissez ou importez vos articles (coupelles, cornets, cuillères…). À
chaque facture, les lignes sont rapprochées de vos articles — par référence, par
libellé déjà connu, puis par ressemblance — et les quantités sont sorties du
stock. L'opération est réversible et jamais appliquée deux fois. Chaque
mouvement est daté et traçable. Un devis n'impacte pas le stock ; un avoir
réintègre la marchandise.

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
   de coordonnées GPS ; il les recherche en lot pour les rendre utilisables dans
   les tournées.
4. **Stock → Nouveau consommable** (ou Importer). Renseignez la référence, la
   quantité et le seuil d'alerte.
5. **Déposez vos factures** dans `Documents\CompaGelato\Factures`. Elles
   apparaissent en quelques secondes.
6. **Documents.** Vérifiez l'association des lignes au stock, puis
   « Déduire du stock ».
7. **Tournées.** Ajoutez vos arrêts, épinglez ceux qui doivent rester en place,
   optimisez, puis envoyez sur le téléphone.

Le bouton **Charger la démonstration** (Réglages → Données) remplit le logiciel
avec un jeu d'essai complet, retirable d'un clic.

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
  ipc.ts                  Tous les gestionnaires d'appels
  watcher.ts              Surveillance du dossier
  services/
    pdf.ts                Extraction PDF, reconstruction lignes et colonnes
    parseInvoice.ts       Lecture des factures/devis français
    facturx.ts            Factur-X (CII) et UBL 2.1
    tabular.ts            CSV/Excel : séparateur, encodage, colonnes
    documents.ts          Analyse du dossier, dédoublonnage, ingestion
    clients.ts            Import, rapprochement, fusion
    stock.ts              Rapprochement articles, mouvements
    routing.ts            Adresses, matrices de distances, carburants
    optimize.ts           Voyageur de commerce avec contraintes d'épinglage
    routes.ts             Calcul de coût, optimisation d'une tournée
    dashboard.ts          Agrégats
    exports.ts            Exports CSV
src/                      Interface React
shared/                   Types et contrat IPC partagés
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

- **26 tests unitaires** — lecture de nombres et dates français, CSV avec
  guillemets et sauts de ligne, décodage Windows-1252, reconnaissance de
  colonnes, extraction PDF sur de vraies factures, Factur-X et UBL, optimisation
  de tournée (comparée à une recherche exhaustive), respect des épinglages,
  liens Google Maps / Waze / Plans, lecture des réponses OSRM et Valhalla.
- **17 tests de bout en bout** — l'application réelle est lancée, pilotée et
  vérifiée : import d'une liste clients en Windows-1252, import du catalogue,
  analyse d'un dossier de PDF, rattachement automatique aux clients, association
  des lignes au stock, déduction puis annulation, idempotence, absence de
  doublons, optimisation avec arrêt épinglé, génération des liens et QR codes,
  exports, navigation dans chaque écran, et reprise automatique d'un fichier
  déposé pendant que le logiciel tourne, rattachement d'une facture dépourvue
  de libellé « Client : », ouverture de chaque fenêtre de saisie.
