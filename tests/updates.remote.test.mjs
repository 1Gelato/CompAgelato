import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

/**
 * Mise à jour d'un poste branché sur le serveur.
 *
 * L'application de bureau tourne depuis sa propre copie du dépôt, même quand
 * ses données viennent du serveur. « Installer la mise à jour » doit donc
 * mettre à jour **ce poste** — et continuer de fonctionner serveur éteint, un
 * `git pull` n'ayant que faire du serveur. La version précédente renvoyait ces
 * deux canaux au serveur comme les autres : le bouton refusait de s'exécuter
 * dès que le serveur dormait, et n'aurait de toute façon mis à jour que la
 * machine d'en face.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const serverBundle = path.join(root, 'dist', 'server', 'server.mjs');

const PORT = 4683;
const TOKEN = 'jeton-maj';
const BASE = `http://127.0.0.1:${PORT}`;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-maj-'));
const serverData = path.join(workspace, 'serveur');
const userData = path.join(workspace, 'poste');

let child = null;
let serverLog = '';
let app;
let page;

function startServer() {
  child = spawn(process.execPath, [serverBundle], {
    env: {
      ...process.env,
      COMPAGELATO_DATA_DIR: serverData,
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

test.before(async () => {
  assert.ok(fs.existsSync(serverBundle), 'lancer npm run build d’abord');
  startServer();
  await waitUp();

  app = await electron.launch({
    args: [path.join(root, 'dist/main/main.mjs'), `--user-data-dir=${userData}`, '--no-sandbox'],
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      // C'est ce réglage qui met le poste en mode branché.
      COMPAGELATO_SERVER_URL: BASE,
      COMPAGELATO_SERVER_TOKEN: TOKEN,
    },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.sidebar__name', { timeout: 30000 });
});

test.after(async () => {
  await app?.close();
  if (child && child.exitCode === null) child.kill('SIGTERM');
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('le poste est bien branché sur le serveur', async () => {
  const info = await page.evaluate(() => window.api.app.info());
  assert.equal(info.mode, 'remote', 'le test ne prouverait rien en mode local');

  // La copie locale s'écrit au démarrage : sans elle, l'extinction du serveur
  // ouvrirait un dialogue au lieu de basculer hors ligne.
  for (let i = 0; i < 40 && !fs.existsSync(path.join(userData, 'miroir.json')); i++) {
    await page.waitForTimeout(250);
  }
  assert.ok(fs.existsSync(path.join(userData, 'miroir.json')), 'miroir non écrit');
});

test('serveur éteint : la mise à jour du poste reste possible', async () => {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);

  // Premier appel : la panne se découvre à cet instant, l'erreur est celle du
  // réseau.
  await assert.rejects(
    () => page.evaluate(() => window.api.documents.scan({})),
    /injoignable/,
    'l’analyse de dossier doit toujours réclamer le serveur',
  );
  assert.equal(await page.evaluate(() => window.api.sync.status().then((s) => s.online)), false);

  // Appels suivants : le poste se sait hors ligne et le dit court. C'est ce
  // message-là que le bouton de mise à jour affichait à tort.
  await assert.rejects(
    () => page.evaluate(() => window.api.documents.scan({})),
    /[Hh]ors ligne/,
  );

  // La mise à jour, elle, concerne le code installé ici : elle répond.
  const check = await page.evaluate(() => window.api.updates.check());
  assert.equal(typeof check.supported, 'boolean', `réponse inattendue : ${JSON.stringify(check)}`);
  assert.equal(typeof check.available, 'boolean');
  if (check.supported) {
    assert.match(check.currentCommit ?? '', /^[0-9a-f]{7,40}$/, 'commit du dépôt de ce poste');
  }
});
