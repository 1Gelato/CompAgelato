import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apiConfig,
  buildApi,
  configureApi,
  hasMirror,
  initOffline,
  invoke,
  isOffline,
  normalizeServerUrl,
  pullNow,
  retryNow,
  serverCall,
  syncStatus,
} from './build/mobile.mjs';

/**
 * Le client mobile, de bout en bout : le cœur de l'app Expo (`mobile/src/
 * core/`) exercé contre un vrai serveur — connexion d'appareil de 180 jours,
 * miroir, coupure réelle (serveur tué), pointage d'une livraison hors ligne,
 * rejeu au redémarrage. Ce que fera le Redmi en tournée, la suite le prouve
 * ici.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const serverBundle = path.join(root, 'dist', 'server', 'server.mjs');

const PORT = 4682;
const TOKEN = 'jeton-mobile';
const BASE = `http://127.0.0.1:${PORT}`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-mobile-'));
const dataDir = path.join(tmpRoot, 'serveur');
const phoneDir = path.join(tmpRoot, 'telephone');
fs.mkdirSync(phoneDir, { recursive: true });

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

/** Le stockage du téléphone, version Node : mêmes deux fichiers, un dossier. */
const phoneStorage = {
  async read(name) {
    const file = path.join(phoneDir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  },
  async write(name, content) {
    fs.writeFileSync(path.join(phoneDir, name), content, 'utf8');
  },
};

/** `api.routes.save(...)` — l'objet que manipulent les écrans. */
const api = buildApi(invoke);

let routeId = '';
let stopId = '';

test('adresse : les formes saisies se ramènent à une seule', () => {
  assert.equal(normalizeServerUrl('100.100.53.66:4680'), 'http://100.100.53.66:4680');
  assert.equal(normalizeServerUrl('  http://oldpc:4680/ '), 'http://oldpc:4680');
});

test('démarrage : compte gérant, session d’appareil de 180 jours', async () => {
  assert.ok(fs.existsSync(serverBundle), 'lancer npm run build d’abord');
  startServer();
  await waitUp();

  configureApi({ baseUrl: BASE, token: TOKEN });
  await initOffline(phoneStorage);

  await serverCall('auth', 'saveUser', [
    { username: 'oliver', displayName: 'Oliver', role: 'gerant', password: 'motdepasse-solide' },
  ]);
  const outcome = await serverCall('auth', 'login', [
    { username: 'oliver', password: 'motdepasse-solide', device: true, label: 'Téléphone de test' },
  ]);
  configureApi({ token: outcome.token });

  // `device: true` a bien ouvert une session longue : personne ne tape un mot
  // de passe à 6 h du matin dans une camionnette.
  const days = (Date.parse(outcome.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 170, `session de ${Math.round(days)} jours, attendu ~180`);
});

test('préparation : un client et une tournée de deux arrêts', async () => {
  const client = await api.clients.save({
    name: 'GLACIER DES EMBRUNS',
    phone: '02 40 00 00 00',
    address: { label: '1 rue du Port, 44600 Saint-Nazaire' },
  });

  const route = await api.routes.save({
    name: 'Tournée du matin',
    stops: [
      {
        id: 'stp_test_1',
        clientId: client.id,
        label: 'GLACIER DES EMBRUNS',
        address: { label: '1 rue du Port, 44600 Saint-Nazaire' },
        pinned: false,
        serviceMinutes: 10,
      },
      {
        id: 'stp_test_2',
        label: 'BAR DU REMBLAI',
        address: { label: '2 quai des Marées, 44380 Pornichet' },
        pinned: false,
        serviceMinutes: 5,
      },
    ],
  });
  routeId = route.id;
  stopId = 'stp_test_1';
  assert.equal(route.stops.length, 2);
});

test('le téléphone se synchronise : miroir écrit sur l’appareil', async () => {
  await pullNow();
  assert.equal(hasMirror(), true);
  assert.ok(fs.existsSync(path.join(phoneDir, 'miroir.json')));

  const routes = await api.routes.list();
  assert.equal(routes.length, 1);
  assert.equal(routes[0].name, 'Tournée du matin');
});

test('le téléphone s’abonne aux notifications, et le serveur retient l’appareil', async () => {
  // Le chemin réel de l'application : après connexion, elle confie son jeton
  // Firebase au serveur, qui s'en servira pour la réveiller.
  const outcome = await api.push.register({
    token: 'jeton-firebase-de-test',
    label: 'Pixel 7 de test',
    platform: 'android',
  });
  assert.equal(outcome.registered, true);
  // Aucune clé Firebase sur ce serveur de test : l'app doit pouvoir le savoir
  // pour ne pas promettre des notifications qui ne partiront jamais.
  assert.equal(outcome.enabled, false);

  const devices = await api.push.devices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].label, 'Pixel 7 de test');
  assert.equal(devices[0].username, 'oliver');

  // Rouvrir l'application ne crée pas de doublon.
  await api.push.register({ token: 'jeton-firebase-de-test', label: 'Pixel 7' });
  assert.equal((await api.push.devices()).length, 1);

  // L'essai le dit franchement quand le serveur n'a pas sa clé.
  const essai = await api.push.test();
  assert.equal(essai.sent, 0);
  assert.match(essai.reason, /clé Firebase|COMPAGELATO_FCM_KEY_FILE/);
});

test('une tâche notée hors ligne part en file et arrive au retour du réseau', async () => {
  // Une tâche se note souvent là où il n'y a pas de réseau — c'est le cas
  // d'usage, pas un cas limite.
  await api.tasks.save({ title: 'Tâche de préparation', priority: 'normal' });
  await pullNow();

  await stopServer();
  const horsLigne = await api.tasks.save({
    title: 'Rappeler le camping',
    priority: 'urgent',
  });
  assert.equal(horsLigne.priority, 'urgent');
  assert.ok(horsLigne.id, 'un identifiant est pré-assigné pour le rejeu');

  // Elle est visible tout de suite, et l'urgent passe devant.
  const locales = await api.tasks.list();
  assert.equal(locales[0].title, 'Rappeler le camping', 'l’urgent d’abord, même hors ligne');
  assert.ok(syncStatus().pending.length >= 1, 'l’intention attend le réseau');

  startServer();
  await waitUp();
  const status = await retryNow();
  assert.equal(status.pending.length, 0, 'la file a été rejouée');
  assert.equal(status.failed.length, 0);

  // Vérifié côté serveur : c'est ce que verra le bureau.
  const res = await fetch(`${BASE}/api/tasks/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': apiConfig().token },
    body: JSON.stringify({ args: [] }),
  });
  const { result: tasks } = await res.json();
  const rejouee = tasks.find((t) => t.id === horsLigne.id);
  assert.ok(rejouee, 'la tâche notée hors ligne n’est pas arrivée sur le serveur');
  assert.equal(rejouee.title, 'Rappeler le camping');
  assert.equal(rejouee.priority, 'urgent');
});

test('coupure en pleine tournée : lecture sur le miroir, pointage en file', async () => {
  await stopServer();

  // Les écrans continuent : la tournée se lit depuis la copie locale.
  const routes = await api.routes.list();
  assert.equal(routes.length, 1, 'la tournée vient du miroir');
  assert.equal(isOffline(), true, 'la coupure a été détectée');

  // Le geste central : marquer un arrêt livré, en zone blanche.
  const tour = routes[0];
  const saved = await api.routes.save({
    ...tour,
    stops: tour.stops.map((s) =>
      s.id === stopId ? { ...s, doneAt: new Date().toISOString() } : s,
    ),
  });
  assert.ok(saved.stops.find((s) => s.id === stopId).doneAt, 'pointage visible immédiatement');

  const status = syncStatus();
  assert.equal(status.online, false);
  assert.equal(status.pending.length, 1, 'l’intention attend le retour du réseau');
  assert.ok(fs.existsSync(path.join(phoneDir, 'attente.json')));

  // Ce qui exige le serveur le dit clairement.
  await assert.rejects(() => api.documents.scan({}), /[Hh]ors ligne/);
});

test('retour du réseau : le pointage arrive sur le serveur', async () => {
  startServer();
  await waitUp();

  const status = await retryNow();
  assert.equal(status.online, true);
  assert.equal(status.pending.length, 0, 'la file a été rejouée');
  assert.equal(status.failed.length, 0);

  // Vérifié côté serveur, pas seulement côté téléphone : c'est ce que verra
  // le bureau, coche verte sur l'arrêt.
  const res = await fetch(`${BASE}/api/routes/list`, {
    method: 'POST',
    // Des comptes existent : c'est la session du téléphone qui fait foi,
    // le jeton partagé d'installation ne suffit plus.
    headers: { 'Content-Type': 'application/json', 'x-auth-token': apiConfig().token },
    body: JSON.stringify({ args: [] }),
  });
  const { result: routes } = await res.json();
  const stop = routes.find((r) => r.id === routeId).stops.find((s) => s.id === stopId);
  assert.ok(stop.doneAt, 'doneAt absent sur le serveur après rejeu');
});

test('arrêt propre', async () => {
  await stopServer();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
