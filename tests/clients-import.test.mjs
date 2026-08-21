import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dataStore,
  importClientsFile,
  guessMapping,
  CLIENT_FIELDS,
  cleanAddressLine,
  parseAddressLine,
  repairAddress,
} from './build/services.mjs';

/**
 * La liste clients vient d'un export comptable (MEG) : deux téléphones par
 * fiche, prénom et nom séparés, adresse éclatée sur sept colonnes. Chaque
 * défaut constaté sur les vraies données est figé ici : le portable qui
 * écrasait le fixe, le prénom perdu, l'adresse en un seul bloc, et le
 * ré-import qui effaçait ce que le fichier n'apportait pas.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-clients-'));
const dataDir = path.join(dir, 'donnees');

/* ------------------------------------------------------------------ */
/* Réparation des fiches déjà en base, au chargement                    */
/* ------------------------------------------------------------------ */

// La base est écrite AVANT d'initialiser le magasin : c'est l'état réel des
// fiches importées avant le découpage d'adresse.
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'compagelato-data.json'),
  JSON.stringify({
    clients: [
      {
        id: 'cli_bloc',
        code: 'CLT00000111',
        name: '11H59',
        address: { label: '10 RUE MAURICE GRIMAUD 75018 PARIS FRANCE', country: 'France' },
        tags: [],
        aliases: [],
        archived: false,
        createdAt: '2026-08-08T10:00:00.000Z',
        updatedAt: '2026-08-08T10:00:00.000Z',
        rev: 5,
      },
      {
        id: 'cli_sain',
        code: 'CL0412',
        name: 'ACCOORD',
        address: {
          label: '9 rue Jean de la Bruyère, 44300 Nantes',
          street: '9 rue Jean de la Bruyère',
          postcode: '44300',
          city: 'Nantes',
          country: 'France',
          lat: 47.23,
          lon: -1.54,
        },
        tags: [],
        aliases: [],
        archived: false,
        createdAt: '2026-08-08T10:00:00.000Z',
        updatedAt: '2026-08-08T10:00:00.000Z',
        rev: 4,
      },
    ],
    sync: { generation: 'gen_test', maxRev: 5, floorRev: 0, tombstones: {} },
  }),
);

test.before(() => {
  dataStore.init({
    dataDir,
    documentsDir: path.join(dir, 'Documents'),
  });
});

test.after(() => {
  dataStore.flushSync();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('une adresse en un seul bloc est décomposée au chargement', () => {
  const client = dataStore.db.clients.find((c) => c.id === 'cli_bloc');
  assert.equal(client.address.street, '10 RUE MAURICE GRIMAUD');
  assert.equal(client.address.postcode, '75018');
  assert.equal(client.address.city, 'PARIS');
  assert.equal(client.address.country, 'France');
  // La ligne se réécrit proprement, sans le pays qui gênait la géolocalisation.
  assert.equal(client.address.label, '10 RUE MAURICE GRIMAUD, 75018 PARIS');
  // La révision a été renouvelée : la réparation part vers les téléphones.
  assert.ok(client.rev > 5, `rev attendue > 5, obtenue ${client.rev}`);
});

test('une fiche déjà décomposée ne bouge pas', () => {
  const client = dataStore.db.clients.find((c) => c.id === 'cli_sain');
  assert.equal(client.rev, 4);
  assert.equal(client.address.lat, 47.23);
});

/* ------------------------------------------------------------------ */
/* Le nettoyage et le découpage d'une ligne d'adresse                   */
/* ------------------------------------------------------------------ */

test('les scories recopiées depuis un document sont retirées', () => {
  assert.equal(
    cleanAddressLine('158 RUE DE BELGIQUE atonaise56@gmail.com 09 54 93 49 90'),
    '158 RUE DE BELGIQUE',
  );
  // Un code postal n'est pas un téléphone : cinq chiffres, il reste.
  assert.equal(cleanAddressLine('12 avenue du Port 06000 NICE'), '12 avenue du Port 06000 NICE');
});

test('le découpage isole rue, code postal, ville et pays', () => {
  assert.deepEqual(parseAddressLine('10 RUE MAURICE GRIMAUD 75018 PARIS FRANCE'), {
    street: '10 RUE MAURICE GRIMAUD',
    postcode: '75018',
    city: 'PARIS',
    country: 'France',
  });
  // La mention CEDEX est postale, elle ne fait pas partie de la ville.
  assert.deepEqual(parseAddressLine('9 rue Jean de la Bruyère 44300 Nantes Cedex 3'), {
    street: '9 rue Jean de la Bruyère',
    postcode: '44300',
    city: 'Nantes',
  });
  // Sans code postal, tout reste en rue : deviner ferait pire que s'abstenir.
  assert.deepEqual(parseAddressLine('LORS CRAN'), { street: 'LORS CRAN' });
});

test('la réparation ne touche que les fiches incomplètes', () => {
  const repaired = repairAddress({ label: '1 rue Haute 44880 Sautron', country: 'France' });
  assert.equal(repaired.city, 'Sautron');
  assert.equal(repaired.postcode, '44880');

  // Déjà complète : rien à faire, la fiche reste telle quelle.
  assert.equal(
    repairAddress({ label: 'x', street: 'x', postcode: '44000', city: 'Nantes' }),
    null,
  );
  // Rien d'exploitable : on n'invente rien.
  assert.equal(repairAddress({ label: '' }), null);
});

/* ------------------------------------------------------------------ */
/* La reconnaissance des colonnes d'un export MEG                       */
/* ------------------------------------------------------------------ */

// L'en-tête exact de l'export MEG de Quentin, banque comprise.
const MEG_HEADERS = [
  'Code', 'Type', 'Civilité', 'Nom', 'Prenom', 'Raison sociale', 'Forme juridique', 'Famille',
  'Téléphone 1', 'Portable', 'Fax', 'Email', 'Site web', 'Informations TVA N° TVA Intra',
  'Commentaire', 'Adresse principale Adresse 1', 'Adresse principale Adresse 2',
  'Adresse principale Adresse 3', 'Adresse principale Code postal', 'Adresse principale Cedex',
  'Adresse principale Ville', 'Adresse principale Pays', 'Banque 1 Nom', 'Banque 1 Domiciliation',
  'Banque 1 IBAN', 'Banque 1 BIC', 'Compte comptable', 'Informations TVA Localisation',
  'Informations TVA Type d’activité', 'Informations TVA Type de TVA',
];

test('les colonnes d’un export MEG sont toutes reconnues à leur place', () => {
  const mapping = guessMapping(MEG_HEADERS, CLIENT_FIELDS);
  assert.equal(mapping.code, 'Code');
  assert.equal(mapping.name, 'Nom');
  assert.equal(mapping.firstName, 'Prenom');
  assert.equal(mapping.legalName, 'Raison sociale');
  // Les deux numéros coexistent : le portable n'écrase plus le fixe.
  assert.equal(mapping.phone, 'Téléphone 1');
  assert.equal(mapping.mobile, 'Portable');
  assert.equal(mapping.email, 'Email');
  assert.equal(mapping.vatNumber, 'Informations TVA N° TVA Intra');
  assert.equal(mapping.notes, 'Commentaire');
  assert.equal(mapping.tags, 'Famille');
  assert.equal(mapping.street, 'Adresse principale Adresse 1');
  assert.equal(mapping.street2, 'Adresse principale Adresse 2');
  assert.equal(mapping.street3, 'Adresse principale Adresse 3');
  assert.equal(mapping.postcode, 'Adresse principale Code postal');
  assert.equal(mapping.city, 'Adresse principale Ville');
  assert.equal(mapping.country, 'Adresse principale Pays');
  // Le fax et la banque n'ont pas leur place dans une fiche.
  assert.ok(!Object.values(mapping).includes('Fax'));
  assert.ok(!Object.values(mapping).some((c) => c.startsWith('Banque')));
});

/* ------------------------------------------------------------------ */
/* L'import d'un fichier MEG                                            */
/* ------------------------------------------------------------------ */

const MEG_ROWS = [
  // Une société : raison sociale ET nom commercial, deux téléphones.
  {
    Code: 'CL0056', Nom: '29 HOOD UJAP SURF CLUB', Prenom: '', 'Raison sociale': '29 HOOD SARL',
    'Téléphone 1': '02 40 00 00 00', Portable: '07 87 51 56 47', Email: 'contact@29hood.com',
    Famille: 'CLIENT', 'Adresse principale Adresse 1': 'LORS CRAN',
    'Adresse principale Code postal': '29760', 'Adresse principale Ville': 'PENMARCH',
    'Adresse principale Pays': 'FRANCE',
  },
  // Un particulier : le prénom rejoint le nom.
  {
    Code: 'CL0418', Nom: 'ZENATI', Prenom: 'Abdel Kader', 'Raison sociale': '',
    'Téléphone 1': '', Portable: '06 11 22 33 44', Email: 'zenatikader@hotmail.fr',
    Famille: 'CLIENT', 'Adresse principale Adresse 1': '221 Place Etienne Marcel',
    'Adresse principale Code postal': '78180', 'Adresse principale Ville': 'Montigny-le-Bretonneux',
    'Adresse principale Pays': 'FRANCE',
  },
  // Ni nom ni prénom : la raison sociale sert de nom.
  {
    Code: 'CL0900', Nom: '', Prenom: '', 'Raison sociale': 'SARL LES GIVRES',
    'Téléphone 1': '02 51 00 00 00', Portable: '', Email: '',
    Famille: 'CLIENT', 'Adresse principale Adresse 1': '2 quai des Glaces',
    'Adresse principale Code postal': '44600', 'Adresse principale Ville': 'Saint-Nazaire',
    'Adresse principale Pays': 'FRANCE',
  },
];

function writeMegCsv(file) {
  const lines = [MEG_HEADERS.join('\t')];
  for (const row of MEG_ROWS) {
    lines.push(MEG_HEADERS.map((h) => row[h] ?? '').join('\t'));
  }
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
}

test('l’import MEG remplit les deux téléphones et compose les noms', async () => {
  const file = path.join(dir, 'export-meg.csv');
  writeMegCsv(file);
  const report = await importClientsFile(file);
  assert.deepEqual(report.errors, []);
  assert.equal(report.created, 3);

  const societe = dataStore.db.clients.find((c) => c.code === 'CL0056');
  assert.equal(societe.name, '29 HOOD UJAP SURF CLUB');
  assert.equal(societe.legalName, '29 HOOD SARL');
  assert.equal(societe.phone, '02 40 00 00 00');
  assert.equal(societe.mobile, '07 87 51 56 47');
  assert.equal(societe.address.city, 'PENMARCH');
  assert.equal(societe.address.postcode, '29760');

  const particulier = dataStore.db.clients.find((c) => c.code === 'CL0418');
  assert.equal(particulier.name, 'Abdel Kader ZENATI');
  assert.equal(particulier.mobile, '06 11 22 33 44');
  assert.equal(particulier.phone, undefined);

  const sansNom = dataStore.db.clients.find((c) => c.code === 'CL0900');
  assert.equal(sansNom.name, 'SARL LES GIVRES');
});

test('un fichier à adresse en une colonne est découpé à l’import', async () => {
  const file = path.join(dir, 'liste-simple.csv');
  fs.writeFileSync(
    file,
    'Code;Nom;Adresse\nCL0901;GLACIER DU PORT;5 quai de la Fosse 44000 NANTES FRANCE\n',
    'utf8',
  );
  const report = await importClientsFile(file);
  assert.deepEqual(report.errors, []);

  const client = dataStore.db.clients.find((c) => c.code === 'CL0901');
  assert.equal(client.address.street, '5 quai de la Fosse');
  assert.equal(client.address.postcode, '44000');
  assert.equal(client.address.city, 'NANTES');
  assert.equal(client.address.label, '5 quai de la Fosse, 44000 NANTES');
});

test('ré-importer un fichier plus pauvre n’efface rien', async () => {
  const avant = dataStore.db.clients.find((c) => c.code === 'CL0056');
  assert.equal(avant.email, 'contact@29hood.com');

  // Le même client, dans un fichier sans e-mail ni téléphones.
  const file = path.join(dir, 'reimport.csv');
  fs.writeFileSync(file, 'Code;Nom\nCL0056;29 HOOD UJAP SURF CLUB\n', 'utf8');
  const report = await importClientsFile(file);
  assert.equal(report.updated, 1);
  assert.equal(report.created, 0);

  const apres = dataStore.db.clients.find((c) => c.code === 'CL0056');
  assert.equal(apres.email, 'contact@29hood.com');
  assert.equal(apres.phone, '02 40 00 00 00');
  assert.equal(apres.mobile, '07 87 51 56 47');
  assert.equal(apres.address.city, 'PENMARCH');
});

test('un e-mail saisi dans l’adresse est retiré, même sur une fiche déjà découpée', () => {
  // Saisie héritée : une collègue notait le contact au milieu de l'adresse.
  // Le code postal et la ville étant renseignés, la réparation s'arrêtait là
  // et la scorie restait — affichée dans le carnet, et posée telle quelle au
  // service d'adresses, qui ne reconnaissait alors plus rien.
  const repaired = repairAddress({
    label: '158 RUE DE BELGIQUE atonaise56@gmail.com 09 54 93 49 90 56100 LORIENT',
    street: '158 RUE DE BELGIQUE atonaise56@gmail.com 09 54 93 49 90',
    postcode: '56100',
    city: 'LORIENT',
    country: 'France',
  });

  assert.equal(repaired.street, '158 RUE DE BELGIQUE');
  assert.equal(repaired.label, '158 RUE DE BELGIQUE, 56100 LORIENT');
  // Ce qui était juste ne bouge pas.
  assert.equal(repaired.postcode, '56100');
  assert.equal(repaired.city, 'LORIENT');
});

test('une adresse propre n’est jamais réécrite', () => {
  // Le carnet ne doit pas se réordonner tout seul au premier chargement venu :
  // une fiche sans scorie et déjà découpée sort de la réparation intacte.
  assert.equal(
    repairAddress({
      label: '9 rue Jean de la Bruyère, 44300 Nantes',
      street: '9 rue Jean de la Bruyère',
      postcode: '44300',
      city: 'Nantes',
      country: 'France',
    }),
    null,
  );
});
