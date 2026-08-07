import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNELS,
  connectionConfig,
  createRemoteRegistry,
  defaultServerBackupDir,
  downloadToCache,
  initConnection,
  pullServerBackup,
  isRemote,
  normalizeServerUrl,
  pingServer,
  remoteCall,
  saveConnection,
  subscribeEvents,
  uploadFile,
  useLocalForThisRun,
} from './build/services.mjs';

/**
 * L'application de bureau branchée sur un serveur.
 *
 * Le proxy vit dans le processus principal d'Electron, mais il n'importe pas
 * Electron : on peut donc l'exercer tel quel contre un vrai serveur lancé pour
 * l'occasion. C'est exactement le chemin que suit l'application quand une
 * adresse de serveur est enregistrée.
 *
 * Nécessite `npm run build` au préalable (fait par `npm run test:e2e`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const serverBundle = path.join(root, 'dist', 'server', 'server.mjs');
const fixturePdf = path.join(here, 'fixtures', 'pdf', 'FA-2026-0142.pdf');

const PORT = 4678;
const TOKEN = 'jeton-du-poste';
const BASE = `http://127.0.0.1:${PORT}`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-distant-'));
const dataDir = path.join(tmpRoot, 'serveur');
const posteDir = path.join(tmpRoot, 'poste');
const watchDir = path.join(tmpRoot, 'surveille');
fs.mkdirSync(posteDir, { recursive: true });
fs.mkdirSync(watchDir, { recursive: true });

let child = null;
let serverLog = '';

test('adresse de serveur : les formes acceptées se ramènent à une seule', () => {
  assert.equal(normalizeServerUrl('192.168.1.99:4680'), 'http://192.168.1.99:4680');
  assert.equal(normalizeServerUrl('  http://oldpc:4680/  '), 'http://oldpc:4680');
  assert.equal(normalizeServerUrl('https://depot.exemple.fr'), 'https://depot.exemple.fr');
  assert.equal(normalizeServerUrl(''), '');
  assert.throws(() => normalizeServerUrl('http://'), /illisible/);
});

test('jeton : les guillemets d’un copier-coller sont retirés, l’impossible est refusé', () => {
  delete process.env.COMPAGELATO_SERVER_URL;
  delete process.env.COMPAGELATO_SERVER_TOKEN;
  // Dossier à part : les tests suivants attendent un poste vierge, et une
  // liaison enregistrée ici les ferait démarrer en mode branché.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-jeton-'));
  initConnection(dir);

  // Coller `COMPAGELATO_TOKEN="secret"` emmène les guillemets avec la valeur.
  saveConnection({ serverUrl: `127.0.0.1:${PORT}`, token: '"jeton-du-poste"' });
  assert.equal(connectionConfig().token, 'jeton-du-poste');

  // Guillemets typographiques d'un traitement de texte : mêmes retirés.
  saveConnection({ serverUrl: `127.0.0.1:${PORT}`, token: '“jeton-du-poste”' });
  assert.equal(connectionConfig().token, 'jeton-du-poste');

  // Un caractère hors Latin-1 au milieu ne peut pas voyager dans un en-tête
  // HTTP : le refus doit arriver ici, pendant qu'on a le jeton sous les yeux,
  // et non plus tard sous la forme d'un serveur prétendument injoignable.
  assert.throws(
    () => saveConnection({ serverUrl: `127.0.0.1:${PORT}`, token: 'jeton“bizarre' }),
    /position 6|guillemet/i,
  );

  // Le jeton valable précédent n'a pas été écrasé par la tentative refusée.
  assert.equal(connectionConfig().token, 'jeton-du-poste');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('liaison : enregistrée sur le poste, relue au démarrage suivant', () => {
  // Les variables d'environnement l'emportent : on s'assure qu'elles sont vides.
  delete process.env.COMPAGELATO_SERVER_URL;
  delete process.env.COMPAGELATO_SERVER_TOKEN;

  initConnection(posteDir);
  assert.equal(isRemote(), false, 'un poste neuf démarre en local');

  saveConnection({ serverUrl: `127.0.0.1:${PORT}`, token: TOKEN });
  assert.equal(isRemote(), true);
  assert.equal(connectionConfig().serverUrl, BASE);

  // Un second démarrage retrouve la liaison sans qu'on la resaisisse.
  initConnection(posteDir);
  assert.equal(connectionConfig().serverUrl, BASE);
  assert.equal(connectionConfig().token, TOKEN);

  // Le jeton n'est pas réécrit quand seul l'adresse change.
  saveConnection({ serverUrl: `127.0.0.1:${PORT}` });
  assert.equal(connectionConfig().token, TOKEN);

  // Adresse effacée : retour au local, et le jeton ne traîne plus sur le disque.
  saveConnection({ serverUrl: '' });
  assert.equal(isRemote(), false);
  assert.equal(connectionConfig().token, '');
  assert.match(fs.readFileSync(path.join(posteDir, 'connexion.json'), 'utf8'), /"token": ""/);

  saveConnection({ serverUrl: `127.0.0.1:${PORT}`, token: TOKEN });
});

test('serveur éteint : le diagnostic est explicite, pas un plantage', async () => {
  const { ok, error } = await pingServer(connectionConfig(), 1500);
  assert.equal(ok, false);
  assert.ok(error, 'aucun message d’erreur');
});

test('démarrage du serveur', async () => {
  assert.ok(fs.existsSync(serverBundle), 'dist/server/server.mjs absent : lancer npm run build');

  child = spawn(process.execPath, [serverBundle], {
    env: {
      ...process.env,
      COMPAGELATO_DATA_DIR: dataDir,
      COMPAGELATO_PORT: String(PORT),
      COMPAGELATO_HOST: '127.0.0.1',
      COMPAGELATO_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));

  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  assert.ok(up, `le serveur ne répond pas :\n${serverLog}`);
});

test('liaison : le bon jeton passe, le mauvais est refusé avec un message clair', async () => {
  const bon = await pingServer(connectionConfig());
  assert.equal(bon.ok, true);
  assert.equal(bon.authenticated, true);
  assert.equal(bon.error, undefined);

  // Le serveur répond — c'est le jeton qui est mauvais. Confondre les deux
  // enverrait l'utilisateur vérifier son réseau au lieu de son secret.
  const refuse = await pingServer({ serverUrl: BASE, token: 'mauvais-jeton' });
  assert.equal(refuse.ok, true, 'le serveur répond pourtant bien');
  assert.equal(refuse.authenticated, false);
  assert.match(refuse.error, /[Jj]eton/);
});

test('le registre distant couvre tous les canaux déclarés', () => {
  const registry = createRemoteRegistry();
  for (const [namespace, methods] of Object.entries(CHANNELS)) {
    for (const method of methods) {
      assert.equal(
        typeof registry[namespace]?.[method],
        'function',
        `canal absent du registre distant : ${namespace}:${method}`,
      );
    }
  }
});

test('écrire depuis le poste, relire depuis le serveur', async () => {
  const created = await remoteCall('clients', 'save', [
    { name: 'GLACIER DU POSTE', address: { label: '3 rue des Halles, 44000 Nantes' } },
  ]);
  assert.ok(created.id);

  // La donnée est bien celle du serveur, pas une copie locale.
  const direct = await fetch(`${BASE}/api/clients/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': TOKEN },
    body: JSON.stringify({ args: [] }),
  });
  const { result } = await direct.json();
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'GLACIER DU POSTE');
});

test('une erreur du serveur remonte son message, pas un code', async () => {
  // C'est le message du serveur que l'utilisateur verra dans l'application :
  // il doit traverser le proxy intact, sans être remplacé par « Erreur 400 ».
  await assert.rejects(
    () => remoteCall('documents', 'setPrinted', ['piece-inexistante', true]),
    (err) => {
      assert.doesNotMatch(err.message, /^Erreur \d+\.$/, `message perdu : ${err.message}`);
      assert.match(err.message, /introuvable/i);
      return true;
    },
  );
});

test('téléverser un fichier choisi sur le poste', async () => {
  const csv = path.join(posteDir, 'clients.csv');
  fs.writeFileSync(csv, 'nom;adresse;ville;cp\nBAR DU PORT;5 quai Nord;Pornic;44210\n', 'utf8');
  const report = await uploadFile('clients', csv);
  assert.equal(report.created, 1);
});

test('événements du serveur reçus par le poste, et PDF rapatrié pour impression', async () => {
  const received = [];
  const stop = subscribeEvents((channel, payload) => received.push({ channel, payload }));

  await remoteCall('settings', 'update', [{ watchFolder: watchDir }]);
  fs.copyFileSync(fixturePdf, path.join(watchDir, 'FA-2026-0142.pdf'));
  await remoteCall('documents', 'scan', [{}]);

  const documents = await remoteCall('documents', 'list', []);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].totalTTC, 382.8);

  // Le flux est asynchrone : on lui laisse le temps d'arriver.
  for (let i = 0; i < 40 && !received.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  assert.ok(received.length, 'aucun événement reçu du serveur');
  assert.ok(
    received.some((e) => e.channel === 'documents-changed' || e.channel === 'scan-progress'),
    `événements inattendus : ${received.map((e) => e.channel).join(', ')}`,
  );

  // C'est ce fichier-là que le poste enverra à l'imprimante.
  const local = await downloadToCache(`/files/document/${documents[0].id}`, 'Facture FA-2026-0142.pdf');
  assert.ok(fs.existsSync(local));
  assert.deepEqual(fs.readFileSync(local), fs.readFileSync(fixturePdf));
  assert.equal(path.basename(local), 'Facture FA-2026-0142.pdf');
});

test('déposer une facture depuis le poste : elle est analysée sur le serveur', async () => {
  // Le geste que fait « Ajouter des pièces » quand l'application est branchée :
  // le fichier part au serveur, qui le range et l'analyse pour tout le monde.
  const autre = path.join(here, 'fixtures', 'pdf', 'FA-2026-0143.pdf');
  const added = await uploadFile('documents', autre);
  assert.equal(added.length, 1);
  assert.equal(added[0].number, 'FA-2026-0143');

  // Elle est bien rangée dans le dossier surveillé du serveur, sous son nom.
  assert.ok(fs.existsSync(path.join(watchDir, 'FA-2026-0143.pdf')));

  const documents = await remoteCall('documents', 'list', []);
  assert.equal(documents.length, 2);
});

test('un fichier absent du serveur donne une erreur lisible', async () => {
  await assert.rejects(
    () => downloadToCache('/files/document/inexistant', 'x.pdf'),
    /document|introuvable|origine/i,
  );
});

test('copie de sécurité : le poste rapatrie la base du serveur, sans doublon', async () => {
  // Le miroir hors-ligne sait faire *travailler* le poste sans serveur ; il ne
  // saurait pas le remonter. Cette copie-ci, si — c'est elle qui fait que les
  // données existent réellement sur deux machines.
  const dossier = defaultServerBackupDir(posteDir);

  const premier = await pullServerBackup({ dir: dossier, log: () => {} });
  assert.ok(premier, 'la première copie doit être écrite');
  assert.ok(premier.startsWith(dossier), `copie déposée hors du dossier : ${premier}`);

  const copie = JSON.parse(fs.readFileSync(premier, 'utf8'));
  assert.ok(copie.clients.length > 0, 'une copie sans clients ne vaudrait rien');
  assert.ok(copie.settings, 'une copie sans réglages ne serait pas restaurable');

  // Rien n'a changé sur le serveur : la copie détenue est déjà la bonne, et ne
  // doit pas consommer une place dans l'historique du poste.
  assert.equal(await pullServerBackup({ dir: dossier, log: () => {} }), null);

  // Une écriture sur le serveur, et la copie suivante la contient.
  await remoteCall('clients', 'save', [{ name: 'SORBETS DU PORT' }]);
  const suivant = await pullServerBackup({ dir: dossier, log: () => {} });
  assert.ok(suivant, 'la base a changé : une nouvelle copie doit être écrite');
  assert.notEqual(suivant, premier);
  const apres = JSON.parse(fs.readFileSync(suivant, 'utf8'));
  assert.ok(
    apres.clients.some((c) => c.name === 'SORBETS DU PORT'),
    'la copie doit refléter l’état du serveur au moment où elle est prise',
  );
});

test('repli : le poste retombe en local sans perdre sa liaison enregistrée', () => {
  useLocalForThisRun();
  assert.equal(isRemote(), false, 'le repli doit couper le mode branché');

  // Le fichier, lui, garde l'adresse : le prochain démarrage retentera.
  const saved = JSON.parse(fs.readFileSync(path.join(posteDir, 'connexion.json'), 'utf8'));
  assert.equal(saved.serverUrl, BASE);
});

test('arrêt propre', async () => {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const code = await Promise.race([
    exited,
    new Promise((r) => setTimeout(() => r('timeout'), 8000)),
  ]);
  assert.notEqual(code, 'timeout', 'le serveur ne s’arrête pas sur SIGTERM');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
