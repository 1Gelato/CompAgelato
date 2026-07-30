/**
 * Capture d'écran de chaque page avec le jeu de démonstration.
 * Usage : xvfb-run -a node tests/screenshots.mjs [dossier-de-sortie]
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const outDir = process.argv[2] ?? path.join(root, 'tests', 'screens');
fs.mkdirSync(outDir, { recursive: true });

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-shot-'));

const app = await electron.launch({
  args: [path.join(root, 'dist/main/main.mjs'), `--user-data-dir=${path.join(workspace, 'profil')}`, '--no-sandbox'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});

const page = await app.firstWindow();
await page.waitForSelector('.sidebar__name', { timeout: 30000 });
await page.setViewportSize({ width: 1400, height: 900 });

await page.evaluate(async (folder) => {
  await window.api.settings.update({ watchFolder: folder, autoScan: false });
  await window.api.db.seedDemo();
}, path.join(workspace, 'Documents', 'CompaGelato'));

// Déduit le stock d'une facture pour que l'historique ne soit pas vide.
await page.evaluate(async () => {
  const docs = await window.api.documents.list();
  const invoice = docs.find((d) => d.kind === 'invoice');
  if (invoice) await window.api.stock.apply(invoice.id);
});

await page.reload();
await page.waitForSelector('.sidebar__name');
await page.waitForTimeout(900);

const screens = [
  ['Tableau de bord', '01-tableau-de-bord'],
  ['Documents', '02-documents'],
  ['Clients', '03-clients'],
  ['Stock', '04-stock'],
  ['Tournées', '05-tournees'],
  ['Réglages', '06-reglages'],
];

for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => window.api.settings.update({ theme: t }), theme);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(350);

  for (const [label, file] of screens) {
    await page.click(`.navitem:has-text("${label}")`);
    await page.waitForTimeout(700);
    const target = path.join(outDir, `${file}-${theme}.png`);
    await page.screenshot({ path: target });
    console.log('capturé', target);
  }
}

// Vue détaillée d'un document.
await page.evaluate((t) => {
  document.documentElement.dataset.theme = t;
}, 'light');
await page.click('.navitem:has-text("Documents")');
await page.waitForSelector('table.data tbody tr');
await page.click('table.data tbody tr');
await page.waitForSelector('.modal');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(outDir, '07-detail-document-light.png') });
console.log('capturé', path.join(outDir, '07-detail-document-light.png'));

await app.close();
fs.rmSync(workspace, { recursive: true, force: true });
console.log('terminé');
