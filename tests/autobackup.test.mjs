import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  autoBackupOptionsFromEnv,
  backupNow,
  dataStore,
  lastAutoBackup,
  looksLikeDatabase,
  rotateFolder,
  splitFolders,
  startAutoBackup,
} from './build/services.mjs';

/**
 * Les sauvegardes automatiques.
 *
 * Ce qu'on vérifie ici tient en une phrase : la sauvegarde a lieu sans que
 * personne y pense, elle ne se répète pas pour rien, et ce qu'elle recopie
 * ailleurs se rattrape tout seul quand le support était absent. Les deux
 * derniers points comptent autant que le premier — une sauvegarde qui tourne
 * trop chasse l'historique qu'on lui demande de garder, et une copie qui
 * abandonne au premier disque débranché ne protège plus de rien.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-sauvegarde-'));
const dataDir = path.join(root, 'donnees');
const backupsDir = path.join(dataDir, 'backups');

const silence = () => {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backupFiles(dir = backupsDir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

let clients = 0;
/** Une modification quelconque de la base : c'est le compteur qui nous intéresse. */
function modifierLaBase() {
  clients += 1;
  const now = new Date().toISOString();
  dataStore.mutate((db) => {
    db.clients.push({
      id: `cli_${clients}`,
      code: `C${clients}`,
      name: `Client ${clients}`,
      address: { label: '' },
      tags: [],
      aliases: [],
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/**
 * Les noms de sauvegarde portent l'horodatage à la milliseconde : deux passages
 * dans la même milliseconde s'écriraient l'un sur l'autre. Le programme réel n'a
 * pas ce souci — ses passages sont espacés d'heures — mais les tests, si.
 */
const espacer = () => sleep(5);

test.after(() => {
  // Le magasin groupe ses écritures : sans ce vidage, son minuteur se
  // réveillerait après le ménage et se plaindrait d'un dossier disparu.
  dataStore.flushSync();
  fs.rmSync(root, { recursive: true, force: true });
});

test('base neuve : sauvegardée une fois, pas deux', async () => {
  dataStore.init({ dataDir, documentsDir: path.join(root, 'Documents') });

  const premier = await backupNow({ log: silence });
  assert.ok(premier.file, 'la première sauvegarde doit être écrite');
  assert.equal(backupFiles().length, 1);

  const second = await backupNow({ log: silence });
  assert.equal(second.file, null, 'base inchangée : rien ne doit être réécrit');
  assert.equal(backupFiles().length, 1, 'une base inchangée ne doit pas consommer l’historique');
});

test('une modification déclenche la sauvegarde suivante', async () => {
  modifierLaBase();
  await espacer();

  const resultat = await backupNow({ log: silence });
  assert.ok(resultat.file, 'la base a changé : une sauvegarde doit être écrite');
  assert.equal(backupFiles().length, 2);
});

test('la dernière sauvegarde automatique est consultable', () => {
  const derniere = lastAutoBackup();
  assert.ok(derniere, 'l’état doit être écrit pour pouvoir l’afficher dans les réglages');
  assert.ok(fs.existsSync(derniere.file), `fichier annoncé absent : ${derniere.file}`);
  assert.match(derniere.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('le fichier d’état ne se retrouve pas dans la liste des sauvegardes', () => {
  // `listBackups` propose tous les `.json` du dossier à la restauration : y
  // ranger un fichier de service ferait proposer à l'utilisateur de restaurer
  // trois lignes de compteurs à la place de sa comptabilité.
  const proposees = dataStore.listBackups();
  for (const fichier of proposees) {
    assert.notEqual(path.basename(fichier), 'sauvegarde-auto.json');
  }
  assert.ok(
    fs.existsSync(path.join(dataDir, 'sauvegarde-auto.json')),
    'l’état doit vivre à côté de la base, pas dans le dossier des sauvegardes',
  );
});

test('la rotation ne garde que les plus récentes, et ne touche qu’à ses fichiers', () => {
  const dossier = path.join(root, 'rotation');
  fs.mkdirSync(dossier, { recursive: true });
  for (let i = 1; i <= 5; i += 1) {
    fs.writeFileSync(path.join(dossier, `backup-2026-01-0${i}.json`), '{}', 'utf8');
  }
  // Ce dossier peut être une clé USB choisie par l'utilisateur : ce qui ne vient
  // pas de nous n'a pas à disparaître.
  fs.writeFileSync(path.join(dossier, 'photos-2019.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(dossier, 'notes.txt'), 'rien', 'utf8');

  rotateFolder(dossier, 3);

  assert.deepEqual(backupFiles(dossier), [
    'backup-2026-01-03.json',
    'backup-2026-01-04.json',
    'backup-2026-01-05.json',
  ]);
  assert.ok(fs.existsSync(path.join(dossier, 'photos-2019.json')), 'fichier étranger supprimé');
  assert.ok(fs.existsSync(path.join(dossier, 'notes.txt')), 'fichier étranger supprimé');
});

test('le nombre de sauvegardes conservées est respecté', async () => {
  modifierLaBase();
  await espacer();

  await backupNow({ keep: 2, log: silence });
  assert.equal(backupFiles().length, 2);
});

test('la copie vers un dossier extérieur se fait, et se rattrape après une absence', async () => {
  const cle = path.join(root, 'cle-usb');

  modifierLaBase();
  await espacer();
  const premier = await backupNow({ copyTo: [cle], log: silence });
  assert.ok(premier.file);
  assert.deepEqual(premier.copied, [cle]);
  assert.equal(backupFiles(cle).length, 1);

  // Rien n'a changé : ni sauvegarde, ni copie refaite pour rien.
  const encore = await backupNow({ copyTo: [cle], log: silence });
  assert.equal(encore.file, null);
  assert.deepEqual(encore.copied, []);
  assert.equal(backupFiles(cle).length, 1);

  // La clé était débranchée et revient vide, alors que la base n'a pas bougé.
  // Sans reprise, elle resterait vide jusqu'à la prochaine facture saisie.
  fs.rmSync(cle, { recursive: true, force: true });
  const rattrapage = await backupNow({ copyTo: [cle], log: silence });
  assert.equal(rattrapage.file, null, 'la base n’a pas changé : pas de nouvelle sauvegarde');
  assert.deepEqual(rattrapage.copied, [cle], 'la copie manquante doit être refaite');
  assert.equal(backupFiles(cle).length, 1);
});

test('un dossier de copie injoignable n’empêche pas la sauvegarde locale', async () => {
  // Un fichier là où on attend un dossier : la création échouera à coup sûr,
  // sur tous les systèmes.
  const obstacle = path.join(root, 'pas-un-dossier');
  fs.writeFileSync(obstacle, 'ceci est un fichier', 'utf8');
  const impossible = path.join(obstacle, 'sauvegardes');

  modifierLaBase();
  await espacer();
  const avant = backupFiles().length;
  const resultat = await backupNow({ copyTo: [impossible], keep: 30, log: silence });

  assert.ok(resultat.file, 'la sauvegarde locale doit avoir lieu malgré la copie ratée');
  assert.equal(backupFiles().length, avant + 1);
  assert.equal(resultat.failed.length, 1);
  assert.equal(resultat.failed[0].dir, impossible);
  assert.ok(resultat.failed[0].error, 'la raison de l’échec doit être rapportée');
});

test('le planificateur sauvegarde dès son démarrage', async () => {
  modifierLaBase();
  await espacer();
  const avant = backupFiles().length;

  const arreter = startAutoBackup({ everyHours: 24, keep: 30, log: silence });
  try {
    // Le premier passage part sans attendre l'échéance : un serveur qu'on
    // redémarre après avoir travaillé est exactement le moment où une
    // sauvegarde manque.
    for (let essai = 0; essai < 100 && backupFiles().length === avant; essai += 1) {
      await sleep(20);
    }
  } finally {
    arreter();
  }

  assert.equal(backupFiles().length, avant + 1);
});

test('everyHours à 0 : rien ne démarre, et l’arrêt reste sans effet', async () => {
  modifierLaBase();
  await espacer();
  const avant = backupFiles().length;

  const arreter = startAutoBackup({ everyHours: 0, log: silence });
  await sleep(50);
  arreter();

  assert.equal(backupFiles().length, avant, 'désactivé veut dire désactivé');
});

test('les réglages viennent de l’environnement, avec des défauts sûrs', () => {
  assert.deepEqual(autoBackupOptionsFromEnv({}), { everyHours: 24, keep: 30, copyTo: [] });

  assert.deepEqual(
    autoBackupOptionsFromEnv({
      COMPAGELATO_BACKUP_HOURS: '6',
      COMPAGELATO_BACKUP_KEEP: '10',
      COMPAGELATO_BACKUP_COPY: ' D:\\Sauvegardes ; /mnt/nas/compagelato ',
    }),
    { everyHours: 6, keep: 10, copyTo: ['D:\\Sauvegardes', '/mnt/nas/compagelato'] },
  );

  // Une valeur illisible ne doit pas se traduire par « plus de sauvegardes » :
  // on retombe sur le défaut, qui protège.
  assert.equal(autoBackupOptionsFromEnv({ COMPAGELATO_BACKUP_HOURS: 'tous les jours' }).everyHours, 24);
  assert.equal(autoBackupOptionsFromEnv({ COMPAGELATO_BACKUP_KEEP: '0' }).keep, 30);
  assert.equal(autoBackupOptionsFromEnv({ COMPAGELATO_BACKUP_KEEP: '-3' }).keep, 30);

  // Zéro heure, en revanche, est un choix explicite : ne pas sauvegarder.
  assert.equal(autoBackupOptionsFromEnv({ COMPAGELATO_BACKUP_HOURS: '0' }).everyHours, 0);
});

test('une réponse qui n’est pas une base n’est jamais prise pour une sauvegarde', () => {
  // Le poste écrit ce que le serveur lui répond. Un refus d'accès ou une page
  // d'interface arrive avec un corps parfaitement lisible : sans ce contrôle,
  // il finirait rangé sous un nom de sauvegarde, et la rotation chasserait les
  // vraies copies au profit de pages d'erreur.
  assert.equal(looksLikeDatabase('{"clients":[],"settings":{}}'), true);
  assert.equal(looksLikeDatabase('{"documents":[]}'), true);

  assert.equal(looksLikeDatabase('{"ok":false,"error":"Connexion requise."}'), false);
  assert.equal(looksLikeDatabase('<!doctype html><html><body>CompaGelato</body></html>'), false);
  assert.equal(looksLikeDatabase(''), false);
  assert.equal(looksLikeDatabase('null'), false);
  assert.equal(looksLikeDatabase('[]'), false);
});

test('découpage des dossiers de copie', () => {
  assert.deepEqual(splitFolders(undefined), []);
  assert.deepEqual(splitFolders('   '), []);
  assert.deepEqual(splitFolders('D:\\Sauvegardes'), ['D:\\Sauvegardes']);
  assert.deepEqual(splitFolders('/a;;/b;'), ['/a', '/b']);
});
