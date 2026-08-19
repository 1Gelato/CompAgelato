import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Le serveur CompaGelato, de bout en bout : un vrai processus `node
 * dist/server/server.mjs` sur une base temporaire, interrogé en HTTP comme le
 * ferait un navigateur. Nécessite `npm run build` au préalable (fait par
 * `npm run test:e2e`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const serverBundle = path.join(root, 'dist', 'server', 'server.mjs');
const fixturePdf = path.join(here, 'fixtures', 'pdf', 'FA-2026-0142.pdf');

const PORT = 4677;
const TOKEN = 'jeton-de-test';
const BASE = `http://127.0.0.1:${PORT}`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-server-'));
const dataDir = path.join(tmpRoot, 'donnees');
const watchDir = path.join(tmpRoot, 'surveille');
fs.mkdirSync(watchDir, { recursive: true });

let child = null;
let serverLog = '';

function api(namespace, method, args = [], token = TOKEN) {
  return fetch(`${BASE}/api/${namespace}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-auth-token': token } : {}),
    },
    body: JSON.stringify({ args }),
  });
}

async function callOk(namespace, method, args = []) {
  const response = await api(namespace, method, args);
  const payload = await response.json();
  assert.equal(payload.ok, true, `${namespace}:${method} → ${payload.error ?? response.status}`);
  return payload.result;
}

test('serveur : démarrage sur une base vierge', async () => {
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

  // Attente active du démarrage.
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      up = res.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  assert.ok(up, `le serveur ne répond pas :\n${serverLog}`);
});

test('serveur : l’interface web est servie', async () => {
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /CompaGelato/);
});

test('serveur : sans jeton, l’API et les fichiers sont refusés', async () => {
  const res = await api('clients', 'list', [], '');
  assert.equal(res.status, 401);
  const file = await fetch(`${BASE}/files/document/xyz`);
  assert.equal(file.status, 401);
});

test('serveur : un canal inconnu est refusé, un canal de bureau explique pourquoi', async () => {
  const unknown = await api('clients', 'hack');
  assert.equal(unknown.status, 404);
  // Les canaux sont générés de la même liste des deux côtés : un canal inconnu
  // signifie un poste plus récent que le serveur. Le message doit dire quoi
  // faire — c'est ce qui manquait quand l'onglet Tâches tournait dans le vide
  // sur un serveur resté en arrière.
  const inconnu = await unknown.json();
  assert.match(inconnu.error, /mettez le serveur à jour/i);

  const local = await api('app', 'chooseFolder');
  assert.equal(local.status, 400);
  const payload = await local.json();
  assert.match(payload.error, /application de bureau/);
});

test('serveur : créer puis relire un client', async () => {
  const created = await callOk('clients', 'save', [
    { name: 'GLACIER DU SERVEUR', address: { label: '1 rue du Port, 44600 Saint-Nazaire' } },
  ]);
  assert.ok(created.id);
  const clients = await callOk('clients', 'list');
  assert.equal(clients.length, 1);
  assert.equal(clients[0].name, 'GLACIER DU SERVEUR');
});

test('serveur : téléverser une liste clients CSV', async () => {
  const csv = 'nom;adresse;ville;cp\nBAR DE LA PLAGE;2 quai des Marées;Pornichet;44380\n';
  const res = await fetch(`${BASE}/upload/clients`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('clients.csv'),
      'x-auth-token': TOKEN,
    },
    body: csv,
  });
  const payload = await res.json();
  assert.equal(payload.ok, true, payload.error);
  assert.equal(payload.result.created, 1);
});

test('serveur : dépôt d’un PDF, analyse, diffusion SSE et téléchargement', async () => {
  // Flux SSE ouvert avant l'analyse pour capter les événements.
  const controller = new AbortController();
  const ssePromise = (async () => {
    const res = await fetch(`${BASE}/api/events?token=${TOKEN}`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('"channel"')) return buffer;
    }
    return buffer;
  })();

  await callOk('settings', 'update', [{ watchFolder: watchDir }]);
  fs.copyFileSync(fixturePdf, path.join(watchDir, 'FA-2026-0142.pdf'));
  await callOk('documents', 'scan', [{}]);

  const documents = await callOk('documents', 'list');
  assert.equal(documents.length, 1);
  assert.equal(documents[0].number, 'FA-2026-0142');
  assert.equal(documents[0].totalTTC, 382.8);

  const sse = await ssePromise;
  controller.abort();
  assert.ok(
    sse.includes('scan-progress') || sse.includes('documents-changed'),
    `aucun événement SSE reçu :\n${sse.slice(0, 400)}`,
  );

  // Le PDF d'origine se télécharge, en tant que PDF.
  const file = await fetch(`${BASE}/files/document/${documents[0].id}?token=${TOKEN}`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type') ?? '', /application\/pdf/);
  const bytes = await file.arrayBuffer();
  assert.equal(bytes.byteLength, fs.statSync(fixturePdf).size);
});

test('serveur : téléverser une facture depuis un poste, sans partage réseau', async () => {
  const res = await fetch(`${BASE}/upload/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('FA-2026-0777.pdf'),
      'x-auth-token': TOKEN,
    },
    body: fs.readFileSync(fixturePdf),
  });
  const payload = await res.json();
  assert.equal(payload.ok, true, payload.error);
  assert.equal(payload.result.length, 1);

  // Le fichier est rangé dans le dossier surveillé sous son nom d'origine,
  // et non sous le nom temporaire du téléversement.
  assert.ok(fs.existsSync(path.join(watchDir, 'FA-2026-0777.pdf')));

  // Même contenu que la pièce déjà présente : c'est la même facture, elle est
  // reconnue plutôt que dupliquée.
  const documents = await callOk('documents', 'list');
  assert.equal(documents.length, 1, 'la facture a été comptée deux fois');
});

test('serveur : le brouillon d’e-mail se prépare et se télécharge', async () => {
  const [doc] = await callOk('documents', 'list');
  const preparation = await callOk('documents', 'prepareEmail', [doc.id]);
  const outcome = await callOk('documents', 'sendEmail', [
    doc.id,
    { ...preparation.draft, to: 'client@exemple.fr' },
  ]);
  assert.equal(outcome.sent, true);
  assert.ok(outcome.fileUrl, 'pas d’adresse de téléchargement du brouillon');

  const eml = await fetch(`${BASE}${outcome.fileUrl}?token=${TOKEN}`);
  assert.equal(eml.status, 200);
  const content = await eml.text();
  assert.match(content, /To: client@exemple\.fr/);
  assert.match(content, /FA-2026-0142/);

  // La pièce est marquée « envoyée par e-mail ».
  const after = await callOk('documents', 'get', [doc.id]);
  assert.ok(after.emailedAt, 'emailedAt non renseigné');
});

test('serveur : les tâches vivent de bout en bout, corbeille comprise', async () => {
  // Le chemin réellement emprunté par l'onglet Tâches : HTTP, pas un appel de
  // fonction. C'est ce qui manquait — les tests métier passaient pendant que
  // l'écran, lui, tournait dans le vide.
  assert.deepEqual(await callOk('tasks', 'list'), []);

  const urgente = await callOk('tasks', 'save', [
    { title: 'Relancer SNSM LE CROISIC', priority: 'urgent' },
  ]);
  await callOk('tasks', 'save', [{ title: 'Ranger le dépôt', priority: 'low' }]);

  const liste = await callOk('tasks', 'list');
  assert.equal(liste.length, 2);
  assert.equal(liste[0].id, urgente.id, 'l’urgent remonte en tête');
  assert.equal(liste[0].history[0].text, 'créée');

  // « Supprimer » met à la corbeille, et la restauration rend tout.
  const jetee = await callOk('tasks', 'remove', [urgente.id]);
  assert.ok(jetee.deletedAt);
  const restauree = await callOk('tasks', 'restore', [urgente.id]);
  assert.equal(restauree.deletedAt, undefined);
  assert.equal(restauree.title, 'Relancer SNSM LE CROISIC');

  const faite = await callOk('tasks', 'setStatus', [urgente.id, 'done']);
  assert.ok(faite.doneAt);

  // Les tâches descendent aux postes comme les autres collections.
  const pull = await callOk('sync', 'pull', [{}]);
  assert.equal(pull.changes.tasks.length, 2);
});

test('serveur : la base vit bien dans le dossier demandé', async () => {
  const stats = await callOk('db', 'stats');
  assert.ok(stats.file.startsWith(dataDir), `${stats.file} hors de ${dataDir}`);
  // 2 fiches saisies + 1 créée automatiquement depuis la facture analysée.
  assert.equal(stats.counts.clients, 3);
  assert.equal(stats.counts.documents, 1);
});

test('serveur : un poste rapatrie une copie de la base', async () => {
  // C'est ainsi que les données cessent de n'exister que sur le disque du
  // serveur : chaque poste branché en tire une copie, tout seul, régulièrement.
  const response = await fetch(`${BASE}/files/backup?token=${TOKEN}`);
  assert.equal(response.status, 200);

  const copie = JSON.parse(await response.text());
  assert.equal(copie.clients.length, 3);
  assert.equal(copie.documents.length, 1);
  assert.ok(copie.settings, 'une copie sans réglages ne serait pas restaurable');

  // La base entière transite par cette adresse : elle ne s'ouvre pas sans jeton.
  const refus = await fetch(`${BASE}/files/backup`);
  assert.equal(refus.status, 401);
});

test('serveur : arrêt propre', async () => {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
  assert.notEqual(code, 'timeout', 'le serveur ne s’arrête pas sur SIGTERM');

  // La base écrite est relisible et contient bien les données.
  const dbFile = path.join(dataDir, 'compagelato-data.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  assert.equal(db.clients.length, 3);
  assert.equal(db.documents.length, 1);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
