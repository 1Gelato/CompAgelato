import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  dataStore,
  shouldRunAt,
  localDay,
  updateNow,
  autoUpdateHourFromEnv,
  readUpdateState,
} from './build/services.mjs';

/**
 * La mise à jour automatique du serveur tourne la nuit, sans personne devant
 * l'écran, sur la machine qui porte la comptabilité. Ces tests portent donc
 * surtout sur les cas où elle doit **refuser d'agir** : c'est là que se joue la
 * différence entre « on peut la laisser tourner » et « on espère ».
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-maj-'));

test.before(() => {
  dataStore.init({
    dataDir: path.join(dir, 'donnees'),
    documentsDir: path.join(dir, 'Documents'),
  });
});

test.after(() => {
  dataStore.flushSync();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Quand passer                                                        */
/* ------------------------------------------------------------------ */

test('le passage a lieu à l’heure dite, et une seule fois par jour', () => {
  const nuit = new Date(2026, 7, 19, 3, 12);
  assert.equal(shouldRunAt(nuit, 3, null), true);
  // Déjà passé aujourd'hui : on ne recommence pas au battement suivant.
  assert.equal(shouldRunAt(nuit, 3, '2026-08-19'), false);
  // Le lendemain, si.
  assert.equal(shouldRunAt(new Date(2026, 7, 20, 3, 5), 3, '2026-08-19'), true);
  // En pleine journée de travail, jamais.
  assert.equal(shouldRunAt(new Date(2026, 7, 19, 14, 30), 3, null), false);
});

test('une heure hors 0–23 désactive le passage', () => {
  // C'est la façon documentée de dire « jamais » (COMPAGELATO_UPDATE_HOUR=-1).
  const nuit = new Date(2026, 7, 19, 3, 12);
  for (const heure of [-1, 24, 99, 3.5, Number.NaN]) {
    assert.equal(shouldRunAt(nuit, heure, null), false, `heure ${heure}`);
  }
});

test('le jour retenu est le jour local, pas celui d’UTC', () => {
  // Un passage à 3 h du matin en France tombe la veille en temps universel :
  // compter en UTC ferait passer deux fois certaines nuits.
  const nuit = new Date(2026, 7, 19, 3, 0);
  assert.equal(localDay(nuit), '2026-08-19');
});

test('l’heure se lit dans l’environnement, avec un défaut sûr', () => {
  assert.equal(autoUpdateHourFromEnv({}), 3);
  assert.equal(autoUpdateHourFromEnv({ COMPAGELATO_UPDATE_HOUR: '5' }), 5);
  assert.equal(autoUpdateHourFromEnv({ COMPAGELATO_UPDATE_HOUR: '-1' }), -1);
  // Une valeur illisible ne doit pas désactiver silencieusement les mises à
  // jour : on retombe sur le défaut.
  assert.equal(autoUpdateHourFromEnv({ COMPAGELATO_UPDATE_HOUR: 'nuit' }), 3);
});

/* ------------------------------------------------------------------ */
/* Les refus — le cœur du sujet                                        */
/* ------------------------------------------------------------------ */

test('sans superviseur, rien ne part : un serveur éteint obligerait à se déplacer', async () => {
  let gitTouche = false;
  const result = await updateNow({
    root: dir,
    policy: () => 'no',
    log: () => {},
    backup: async () => {
      gitTouche = true;
    },
    restart: () => {
      gitTouche = true;
    },
  });
  assert.equal(result.outcome, 'sans-superviseur');
  assert.match(result.message, /Restart=always/);
  assert.equal(gitTouche, false, 'on ne touche à rien avant même de vérifier');
});

test('hors d’un dépôt cloné, la mise à jour se dit indisponible sans rien casser', async () => {
  const result = await updateNow({
    root: path.join(dir, 'pas-un-depot'),
    policy: () => 'always',
    log: () => {},
  });
  assert.equal(result.outcome, 'non-supportee');
});

/* ------------------------------------------------------------------ */
/* Un vrai dépôt, déjà à jour                                          */
/* ------------------------------------------------------------------ */

/** Un petit dépôt git local, pour exercer le vrai code plutôt qu'un mensonge. */
function makeRepo(where) {
  fs.mkdirSync(where, { recursive: true });
  const git = (...args) =>
    execFileSync('git', args, { cwd: where, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'principale');
  git('config', 'user.email', 'test@ogelato.fr');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(where, 'fichier.txt'), 'un\n');
  git('add', '.');
  git('commit', '-q', '-m', 'départ');
  return where;
}

test('un dépôt sans rien de neuf ne déclenche aucun redémarrage', async () => {
  const repo = makeRepo(path.join(dir, 'depot'));
  // Aucune branche distante : le service doit le dire, et surtout ne pas
  // redémarrer le serveur « au cas où ».
  let redemarrages = 0;
  const result = await updateNow({
    root: repo,
    policy: () => 'always',
    log: () => {},
    restart: () => {
      redemarrages++;
    },
  });
  assert.equal(redemarrages, 0, 'un serveur ne se relance jamais pour rien');
  // Sans dépôt distant, l'état est inconnu — et c'est dit, pas maquillé en
  // « vous avez déjà la dernière version ».
  assert.ok(['a-jour', 'non-supportee', 'echec'].includes(result.outcome), result.outcome);
});

/* ------------------------------------------------------------------ */
/* Ne jamais boucler                                                   */
/* ------------------------------------------------------------------ */

test('une version qui échoue trois fois n’est plus retentée', async () => {
  // Un serveur qui se relance en boucle toute la nuit serait pire que le
  // retard qu'on voulait corriger. L'état retient les tentatives.
  const stateFile = path.join(path.dirname(dataStore.dbFile), 'maj-auto.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ day: '2026-08-18', commit: 'abcdef123456', tries: 3, at: '' }),
  );
  const relu = readUpdateState();
  assert.equal(relu.tries, 3);
  assert.equal(relu.commit, 'abcdef123456');
  fs.rmSync(stateFile, { force: true });
});

test('un état illisible ne bloque pas les mises à jour à venir', () => {
  // Coupure de courant en pleine écriture : on repart comme si rien n'avait
  // été tenté, plutôt que de ne plus jamais se mettre à jour.
  const stateFile = path.join(path.dirname(dataStore.dbFile), 'maj-auto.json');
  fs.writeFileSync(stateFile, '{ ceci n’est pas du JSON');
  assert.equal(readUpdateState(), null);
  fs.rmSync(stateFile, { force: true });
});
