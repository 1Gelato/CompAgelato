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

// Un flyer de démonstration dans la bibliothèque de pièces jointes.
{
  const dir = path.join(workspace, 'Documents', 'CompaGelato', 'Pieces-jointes');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(
    path.join(root, 'tests/fixtures/pdf/DE-2026-0031.pdf'),
    path.join(dir, 'Flyer été 2026.pdf'),
  );
  await page.evaluate(() => window.api.attachments.list());
}

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
await page.click('table.data tbody tr td:nth-child(2)');
await page.waitForSelector('.modal');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(outDir, '07-detail-document-light.png') });
console.log('capturé', path.join(outDir, '07-detail-document-light.png'));
await page.click('.modal__header .iconbtn');
await page.waitForTimeout(300);

// Fenêtre d'envoi par e-mail, avec les pièces jointes cochables.
await page.evaluate(async () => {
  const docs = await window.api.documents.list();
  const quote = docs.find((d) => d.kind === 'quote') ?? docs[0];
  const clients = await window.api.clients.list();
  const client = clients.find((c) => c.id === quote.clientId);
  if (client) await window.api.clients.save({ id: client.id, email: 'contact@exemple.fr' });
});
await page.click('table.data tbody tr td:last-child button[title*="e-mail"], table.data tbody tr button[aria-label*="e-mail"]');
await page.waitForSelector('.modal:has-text("Envoyer")');
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(outDir, '08-envoi-email-light.png') });
console.log('capturé', path.join(outDir, '08-envoi-email-light.png'));

await app.close();
fs.rmSync(workspace, { recursive: true, force: true });
console.log('terminé');
