import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOfflineRegistry,
  discardIntent,
  hasMirror,
  initConnection,
  initOffline,
  isOffline,
  pullNow,
  retryNow,
  saveConnection,
  syncStatus,
} from './build/services.mjs';

/**
 * Le hors-ligne, de bout en bout : un vrai serveur, un vrai poste (le module
 * `offline` tel que l'application de bureau l'utilise), une vraie coupure —
 * le serveur est tué puis relancé — et le rejeu qui s'ensuit.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const serverBundle = path.join(root, 'dist', 'server', 'server.mjs');

const PORT = 4681;
const TOKEN = 'jeton-hors-ligne';
const BASE = `http://127.0.0.1:${PORT}`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-horsligne-'));
const dataDir = path.join(tmpRoot, 'serveur');
const posteDir = path.join(tmpRoot, 'poste');
const watchDir = path.join(tmpRoot, 'surveille');
fs.mkdirSync(posteDir, { recursive: true });
fs.mkdirSync(watchDir, { recursive: true });

let child = null;
let serverLog = '';

function startServer() {
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
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/`)).ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`le serveur ne répond pas :\n${serverLog}`);
}

async function stopServer() {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
}

async function api(namespace, method, args = [], token = TOKEN) {
  const res = await fetch(`${BASE}/api/${namespace}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-auth-token': token } : {}),
    },
    body: JSON.stringify({ args }),
  });
  return { status: res.status, payload: await res.json() };
}

async function callOk(namespace, method, args, token) {
  const { status, payload } = await api(namespace, method, args, token);
  assert.equal(payload.ok, true, `${namespace}:${method} → ${payload.error ?? status}`);
  return payload.result;
}

const pull = (input, token = TOKEN) => callOk('sync', 'pull', [input ?? {}], token);

let generation = '';
let checkpoint = 0;
let productId = '';
let documentId = '';

test('démarrage et amorçage : client, article avec stock initial', async () => {
  assert.ok(fs.existsSync(serverBundle), 'lancer npm run build d’abord');
  startServer();
  await waitUp();

  await callOk('settings', 'update', [{ watchFolder: watchDir }]);
  await callOk('clients', 'save', [{ name: 'GLACIER DES EMBRUNS' }]);
  const product = await callOk('products', 'save', [
    { name: 'Poche de mix vanille', unit: 'poche', qtyOnHand: 10 },
  ]);
  productId = product.id;

  // Le stock initial est un mouvement, pas un nombre posé là : le total
  // repart toujours de la somme du journal.
  assert.equal(product.qtyOnHand, 10);
  const moves = await callOk('stock', 'moves', [productId]);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].qty, 10);
  assert.equal(moves[0].balanceAfter, 10);
});

test('pull complet : toute la base, numérotée', async () => {
  const result = await pull({});
  assert.equal(result.full, true);
  assert.ok(result.generation);
  assert.ok(result.maxRev > 0);
  assert.equal(result.changes.clients.length, 1);
  assert.equal(result.changes.products.length, 1);
  assert.equal(result.changes.stockMoves.length, 1);
  assert.ok(result.settings, 'les réglages descendent avec la base');
  assert.ok(
    result.changes.clients[0].rev > 0,
    'chaque enregistrement porte sa révision',
  );
  generation = result.generation;
  checkpoint = result.maxRev;
});

test('pull delta : seulement ce qui a changé, puis la pierre tombale', async () => {
  const second = await callOk('clients', 'save', [{ name: 'BAR DU REMBLAI' }]);

  const delta = await pull({ generation, since: checkpoint });
  assert.equal(delta.full, false);
  assert.equal(delta.changes.clients.length, 1);
  assert.equal(delta.changes.clients[0].name, 'BAR DU REMBLAI');
  assert.equal(delta.changes.products?.length ?? 0, 0, 'les articles n’ont pas bougé');
  assert.equal(delta.settings, undefined, 'les réglages non plus');
  checkpoint = delta.maxRev;

  await callOk('clients', 'remove', [second.id]);
  const grave = await pull({ generation, since: checkpoint });
  assert.deepEqual(grave.removed.clients, [second.id], 'la suppression descend en pierre tombale');
  checkpoint = grave.maxRev;
});

test('déduction déterministe : annuler puis redéduire recrée les mêmes mouvements', async () => {
  const doc = await callOk('documents', 'save', [
    {
      kind: 'invoice',
      number: 'FA-TEST-0001',
      lines: [{ id: 'lin_fixe_1', label: 'Poche de mix vanille', qty: 2 }],
    },
  ]);
  documentId = doc.id;

  await callOk('stock', 'apply', [documentId]);
  const firstMoves = (await callOk('stock', 'moves', [productId])).filter(
    (m) => m.documentId === documentId,
  );
  assert.equal(firstMoves.length, 1);
  const deterministicId = firstMoves[0].id;
  assert.equal((await callOk('products', 'list', [])).find((p) => p.id === productId).qtyOnHand, 8);

  // L'annulation retire les mouvements du journal (et leur pierre tombale
  // descendra vers les appareils comme n'importe quelle suppression).
  await callOk('stock', 'revert', [documentId]);
  assert.equal((await callOk('products', 'list', [])).find((p) => p.id === productId).qtyOnHand, 10);
  const graves = await pull({ generation, since: checkpoint });
  assert.ok(
    (graves.removed.stockMoves ?? []).includes(deterministicId),
    'le mouvement retiré descend en pierre tombale',
  );
  checkpoint = graves.maxRev;

  // Redéduire recrée exactement le même identifiant : c'est lui qui fait
  // fusionner deux déductions concurrentes au lieu de les cumuler.
  await callOk('stock', 'apply', [documentId]);
  const again = (await callOk('stock', 'moves', [productId])).filter(
    (m) => m.documentId === documentId,
  );
  assert.equal(again[0].id, deterministicId);
  assert.equal((await callOk('products', 'list', [])).find((p) => p.id === productId).qtyOnHand, 8);
});

test('le poste se synchronise : miroir sur disque', async () => {
  delete process.env.COMPAGELATO_SERVER_URL;
  delete process.env.COMPAGELATO_SERVER_TOKEN;
  initConnection(posteDir);
  saveConnection({ serverUrl: `127.0.0.1:${PORT}`, token: TOKEN });
  initOffline(posteDir);
  assert.equal(hasMirror(), false, 'poste neuf : pas encore de copie');

  await pullNow();
  assert.equal(hasMirror(), true);
  assert.ok(fs.existsSync(path.join(posteDir, 'miroir.json')));

  const registry = createOfflineRegistry();
  const clients = await registry.clients.list();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].name, 'GLACIER DES EMBRUNS');
});

test('coupure : les lectures continuent sur le miroir', async () => {
  await stopServer();

  const registry = createOfflineRegistry();
  const clients = await registry.clients.list();
  assert.equal(clients.length, 1, 'la liste vient du miroir');
  assert.equal(isOffline(), true, 'la coupure a été détectée');

  // Les lectures dérivées marchent aussi : documents, mouvements avec solde.
  const documents = await registry.documents.list();
  assert.equal(documents.length, 1);
  const moves = await registry.stock.moves(productId);
  assert.equal(moves.length, 2);
  assert.equal(moves.find((m) => m.documentId === documentId).balanceAfter, 8);
});

test('hors ligne : les écritures deviennent des intentions en file', async () => {
  const registry = createOfflineRegistry();

  const created = await registry.clients.save({ name: 'CRÉÉ HORS LIGNE' });
  assert.ok(created.id.startsWith('cli_'), 'identifiant réel pré-assigné');
  const list = await registry.clients.list();
  assert.equal(list.length, 2, 'l’écran voit la fiche tout de suite (optimiste)');

  // Une intention vouée à l'échec métier : la pièce n'existe pas.
  await registry.documents.setStatus('doc_fantome', 'paid');

  const status = syncStatus();
  assert.equal(status.online, false);
  assert.equal(status.pending.length, 2);
  assert.ok(fs.existsSync(path.join(posteDir, 'attente.json')));

  // Un import de fichier, lui, exige le serveur — et le dit.
  await assert.rejects(() => registry.documents.scan({}), /[Hh]ors ligne/);
});

test('retour du serveur : rejeu dans l’ordre, échec métier présenté', async () => {
  startServer();
  await waitUp();

  const status = await retryNow();
  assert.equal(status.online, true);
  assert.equal(status.pending.length, 0, 'la file a été rejouée');
  assert.equal(status.failed.length, 1, 'le refus métier est conservé, pas avalé');
  assert.match(status.failed[0].error, /introuvable/i);

  // La fiche créée hors ligne est sur le serveur, sous le même identifiant.
  const clients = await callOk('clients', 'list', []);
  const replayed = clients.find((c) => c.name === 'CRÉÉ HORS LIGNE');
  assert.ok(replayed, 'fiche rejouée absente du serveur');
  assert.ok(replayed.id.startsWith('cli_'));
  assert.ok(replayed.code, 'le serveur a complété la fiche (code client)');

  // Et le miroir a adopté la version du serveur, état optimiste jeté.
  const registry = createOfflineRegistry();
  const mirrored = (await registry.clients.list()).find((c) => c.name === 'CRÉÉ HORS LIGNE');
  assert.equal(mirrored.code, replayed.code);

  const cleared = discardIntent(status.failed[0].id);
  assert.equal(cleared.failed.length, 0);
});

test('filtrage par rôle : le miroir d’un livreur ne contient pas la banque', async () => {
  await callOk('auth', 'saveUser', [
    { username: 'oliver', displayName: 'Oliver', role: 'gerant', password: 'motdepasse-solide' },
  ]);
  const gerant = await callOk(
    'auth', 'login',
    [{ username: 'oliver', password: 'motdepasse-solide' }],
    '',
  );
  await callOk(
    'auth', 'saveUser',
    [{ username: 'karim', displayName: 'Karim', role: 'livreur', password: 'tournee-du-matin' }],
    gerant.token,
  );
  const livreur = await callOk(
    'auth', 'login',
    [{ username: 'karim', password: 'tournee-du-matin' }],
    '',
  );

  const filtered = await pull({}, livreur.token);
  assert.equal(filtered.identity.role, 'livreur');
  assert.ok(filtered.changes.clients, 'les clients descendent (lecture autorisée)');
  assert.ok(filtered.changes.routes, 'les tournées descendent');
  assert.ok(filtered.changes.vehicles, 'les véhicules descendent');
  for (const forbidden of [
    'documents', 'stockMoves', 'bankTransactions',
    'registerEntries', 'eventMachines', 'attachments',
  ]) {
    assert.equal(
      filtered.changes[forbidden],
      undefined,
      `${forbidden} ne doit jamais atteindre l'appareil d'un livreur`,
    );
  }

  // Le catalogue, lui, descend : c'est lui qui propose les articles quand le
  // livreur établit un bon, y compris en zone blanche. Mais amputé de ce qui
  // dirait la marge — le retrait a lieu au serveur, pas à l'affichage.
  assert.ok(filtered.changes.products, 'le catalogue doit descendre chez le livreur');
  for (const article of filtered.changes.products) {
    assert.equal(article.unitCost, undefined, 'le prix d’achat descend chez le livreur');
    assert.equal(article.supplier, undefined, 'le fournisseur descend chez le livreur');
  }

  // Le gérant, lui, reçoit tout.
  const complete = await pull({}, gerant.token);
  assert.ok(complete.changes.documents.length >= 1);
  assert.ok(complete.changes.bankTransactions !== undefined);
});

test('restauration : nouvelle génération, les appareils repartent de zéro', async () => {
  const gerant = await callOk(
    'auth', 'login',
    [{ username: 'oliver', password: 'motdepasse-solide' }],
    '',
  );
  const before = await pull({}, gerant.token);

  const exported = await callOk('db', 'exportAll', [], gerant.token);
  const restored = await fetch(`${BASE}/upload/restore`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(path.basename(exported)),
      'x-auth-token': gerant.token,
    },
    body: fs.readFileSync(exported),
  });
  assert.equal((await restored.json()).ok, true);

  // Même contenu, mais autre lignée : un delta fondé sur l'ancienne génération
  // doit être refusé au profit d'une synchronisation complète.
  const after = await pull({ generation: before.generation, since: before.maxRev }, gerant.token);
  assert.equal(after.full, true);
  assert.notEqual(after.generation, before.generation);
});

test('arrêt propre', async () => {
  await stopServer();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
