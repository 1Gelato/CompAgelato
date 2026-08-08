import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Comptes et droits, vérifiés contre un vrai serveur.
 *
 * Le point qui compte : un livreur ne doit pas **recevoir** les données
 * bancaires ni comptables — pas seulement ne pas les afficher. Cacher un bouton
 * dans l'interface ne protège rien ; c'est le serveur qui doit refuser.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const serverBundle = path.join(root, 'dist', 'server', 'server.mjs');
const fixturePdf = path.join(here, 'fixtures', 'pdf', 'FA-2026-0142.pdf');

const PORT = 4679;
const SHARED = 'jeton-partage-historique';
const BASE = `http://127.0.0.1:${PORT}`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-droits-'));
const dataDir = path.join(tmpRoot, 'donnees');
const watchDir = path.join(tmpRoot, 'surveille');
fs.mkdirSync(watchDir, { recursive: true });

let child = null;
let serverLog = '';

/** Session du gérant, puis du livreur. */
let gerantToken = '';
let livreurToken = '';
let documentId = '';

async function api(namespace, method, args = [], token) {
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

test('démarrage : aucun compte, le jeton partagé fait foi comme avant', async () => {
  assert.ok(fs.existsSync(serverBundle), 'dist/server/server.mjs absent : lancer npm run build');

  child = spawn(process.execPath, [serverBundle], {
    env: {
      ...process.env,
      COMPAGELATO_DATA_DIR: dataDir,
      COMPAGELATO_PORT: String(PORT),
      COMPAGELATO_HOST: '127.0.0.1',
      COMPAGELATO_TOKEN: SHARED,
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

  const status = await callOk('auth', 'status', [], SHARED);
  assert.equal(status.configured, false);
  assert.equal(status.required, false);

  // Une installation déjà en service continue de fonctionner à l'identique.
  await callOk('clients', 'list', [], SHARED);
});

test('préparation : une facture et un relevé dans la base', async () => {
  await callOk('settings', 'update', [{ watchFolder: watchDir }], SHARED);
  fs.copyFileSync(fixturePdf, path.join(watchDir, 'FA-2026-0142.pdf'));
  await callOk('documents', 'scan', [{}], SHARED);
  const documents = await callOk('documents', 'list', [], SHARED);
  assert.equal(documents.length, 1);
  documentId = documents[0].id;
});

test('création du premier gérant, puis le jeton partagé ne suffit plus', async () => {
  await callOk(
    'auth',
    'saveUser',
    [{ username: 'oliver', displayName: 'Oliver', role: 'gerant', password: 'motdepasse-solide' }],
    SHARED,
  );

  // Bascule : dès qu'un compte existe, une session est exigée. Le jeton
  // partagé seul ne dit rien du rôle de celui qui s'en sert.
  const { status, payload } = await api('clients', 'list', [], SHARED);
  assert.equal(status, 401);
  assert.equal(payload.authRequired, true);

  const outcome = await callOk(
    'auth',
    'login',
    [{ username: 'oliver', password: 'motdepasse-solide', label: 'Poste bureau' }],
    '',
  );
  assert.equal(outcome.identity.role, 'gerant');
  assert.ok(outcome.token);
  gerantToken = outcome.token;

  const after = await callOk('auth', 'status', [], gerantToken);
  assert.equal(after.configured, true);
  assert.equal(after.required, true);
  assert.equal(after.identity.username, 'oliver');
});

test('le mot de passe n’est jamais stocké en clair, ni le jeton de session', () => {
  const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'compagelato-data.json'), 'utf8'));
  const raw = JSON.stringify(db);
  assert.doesNotMatch(raw, /motdepasse-solide/, 'mot de passe en clair dans la base');
  assert.ok(!raw.includes(gerantToken), 'jeton de session en clair dans la base');
  assert.match(db.users[0].passwordHash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
});

test('le gérant crée un livreur', async () => {
  await callOk(
    'auth',
    'saveUser',
    [{ username: 'karim', displayName: 'Karim', role: 'livreur', password: 'tournee-du-matin' }],
    gerantToken,
  );
  const outcome = await callOk(
    'auth',
    'login',
    [{ username: 'karim', password: 'tournee-du-matin', label: 'Téléphone' }],
    '',
  );
  assert.equal(outcome.identity.role, 'livreur');
  livreurToken = outcome.token;
});

test('le livreur accède à ses tournées et lit les clients', async () => {
  await callOk('routes', 'list', [], livreurToken);
  await callOk('vehicles', 'list', [], livreurToken);
  await callOk('clients', 'list', [], livreurToken);
  await callOk('settings', 'get', [], livreurToken);
});

test('le livreur ne REÇOIT pas la comptabilité, la banque ni le tableau de bord', async () => {
  // Chacun de ces appels doit être refusé par le serveur, pas masqué par
  // l'interface : les données ne doivent jamais transiter.
  for (const [namespace, method] of [
    ['bank', 'list'],
    ['bank', 'summary'],
    ['documents', 'list'],
    ['documents', 'get'],
    ['stats', 'dashboard'],
    ['products', 'list'],
    ['stock', 'moves'],
    ['registers', 'list'],
    ['db', 'stats'],
    ['auth', 'users'],
    ['settings', 'update'],
  ]) {
    const { status, payload } = await api(namespace, method, [], livreurToken);
    assert.equal(status, 403, `${namespace}:${method} aurait dû être refusé`);
    assert.equal(payload.ok, false);
    assert.ok(!('result' in payload), `${namespace}:${method} a renvoyé des données`);
  }
});

test('le livreur ne peut pas récupérer une facture en devinant son identifiant', async () => {
  // Le contrôle porte aussi sur les fichiers : sans cela, l'identifiant seul
  // suffirait à télécharger n'importe quelle pièce.
  const file = await fetch(`${BASE}/files/document/${documentId}?token=${livreurToken}`);
  assert.equal(file.status, 403);

  const upload = await fetch(`${BASE}/upload/bank`, {
    method: 'POST',
    headers: { 'x-auth-token': livreurToken, 'X-File-Name': 'releve.csv' },
    body: 'date;libelle;montant\n',
  });
  assert.equal(upload.status, 403);

  // Le gérant, lui, y accède.
  const ok = await fetch(`${BASE}/files/document/${documentId}?token=${gerantToken}`);
  assert.equal(ok.status, 200);
});

test('un canal de bureau explique pourquoi, même avec les droits', async () => {
  const { status, payload } = await api('app', 'chooseFolder', [], gerantToken);
  assert.equal(status, 400);
  assert.match(payload.error, /application de bureau/);
});

test('mot de passe erroné : message indistinct, puis verrouillage', async () => {
  const inconnu = await api('auth', 'login', [{ username: 'fantome', password: 'x' }], '');
  const mauvais = await api('auth', 'login', [{ username: 'karim', password: 'x' }], '');
  // Le même message dans les deux cas : sinon on saurait quels comptes existent.
  assert.equal(inconnu.payload.error, mauvais.payload.error);

  let locked = '';
  for (let i = 0; i < 10 && !locked; i++) {
    const { payload } = await api('auth', 'login', [{ username: 'karim', password: 'x' }], '');
    if (/Trop de tentatives/.test(payload.error ?? '')) locked = payload.error;
  }
  assert.ok(locked, 'aucun verrouillage après une rafale de tentatives');
});

test('révoquer une session coupe l’accès immédiatement', async () => {
  const sessions = await callOk('auth', 'sessions', [], gerantToken);
  const phone = sessions.find((s) => s.label === 'Téléphone');
  assert.ok(phone, 'session du livreur introuvable');

  await callOk('auth', 'revokeSession', [phone.id], gerantToken);

  const { status } = await api('routes', 'list', [], livreurToken);
  assert.equal(status, 401, 'la session révoquée répond encore');
});

test('le dernier gérant ne peut pas se retirer lui-même les droits', async () => {
  const users = await callOk('auth', 'users', [], gerantToken);
  const oliver = users.find((u) => u.username === 'oliver');

  const { payload } = await api(
    'auth',
    'saveUser',
    [{ id: oliver.id, username: 'oliver', displayName: 'Oliver', role: 'bureau' }],
    gerantToken,
  );
  assert.equal(payload.ok, false);
  assert.match(payload.error, /au moins un gérant/);

  const suppression = await api('auth', 'removeUser', [oliver.id], gerantToken);
  assert.equal(suppression.payload.ok, false);
  assert.match(suppression.payload.error, /votre propre compte/);
});

test('une arrivée est annoncée à tous, en nommant son auteur', async () => {
  // C'est ce qui permet à chaque poste d'écarter ses propres gestes : sans
  // auteur sur l'annonce, chacun serait prévenu de ce qu'il vient de saisir.
  const controller = new AbortController();
  const annonce = (async () => {
    const res = await fetch(`${BASE}/api/events?token=${gerantToken}`, {
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const frame = JSON.parse(line.slice(5).trim());
          if (frame.channel === 'activity') return frame.payload;
        } catch {
          /* trame incomplète : on attend la suite */
        }
      }
    }
    return null;
  })();

  // Le gérant écrit dans un cahier ; l'annonce doit porter *son* identifiant.
  const moi = await callOk('auth', 'status', [], gerantToken);
  await callOk(
    'registers',
    'save',
    [{ kind: 'sav', title: 'Machine en panne', clientName: 'CAMPING LES AJONCS' }],
    gerantToken,
  );

  const payload = await annonce;
  controller.abort();
  assert.ok(payload, 'aucune annonce reçue sur le flux');
  assert.equal(payload.source, 'register');
  assert.equal(payload.by, moi.identity.userId, 'l’annonce ne nomme pas son auteur');
  assert.match(payload.title, /SAV/);
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
