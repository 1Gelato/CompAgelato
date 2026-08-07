import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataStore, defaultWatchFolder, isForeignPath } from './build/services.mjs';

/**
 * Mettre les données en commun sur un serveur, c'est restaurer sur une machine
 * la sauvegarde d'une autre — souvent d'un autre système. Les chemins voyagent
 * avec : `C:\Users\…\CompaGelato` gardé tel quel sur un serveur Linux rendrait
 * chaque pièce introuvable, puisque les documents sont enregistrés
 * relativement au dossier de travail.
 */

test('forme des chemins : ce qui vient d’ailleurs est reconnu', () => {
  const windows = process.platform === 'win32';

  // Chemins Windows, vus d'ici.
  assert.equal(isForeignPath('C:\\Users\\ogela\\Documents\\CompaGelato'), !windows);
  assert.equal(isForeignPath('D:/Donnees/CompaGelato'), !windows);
  assert.equal(isForeignPath('\\\\serveur\\partage\\CompaGelato'), !windows);

  // Chemin POSIX, vu d'ici.
  assert.equal(isForeignPath('/home/oldpc/Documents/CompaGelato'), windows);

  // Rien à signaler.
  assert.equal(isForeignPath(''), false);
  assert.equal(isForeignPath('Factures/FA-2026-0142.pdf'), false);
});

test('sauvegarde d’un poste Windows restaurée ici : le dossier redevient valide', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-restore-'));
  const documents = path.join(dir, 'Documents');
  fs.mkdirSync(documents, { recursive: true });

  try {
    dataStore.init({ dataDir: path.join(dir, 'donnees'), documentsDir: documents });

    // La sauvegarde telle que l'écrit un poste Windows : dossiers absolus,
    // chemins de pièces relatifs au dossier de travail.
    const sauvegarde = path.join(dir, 'sauvegarde.json');
    fs.writeFileSync(
      sauvegarde,
      JSON.stringify({
        version: 1,
        clients: [
          {
            id: 'cli_1',
            name: 'GLACIER DES EMBRUNS',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        documents: [
          {
            id: 'doc_1',
            kind: 'invoice',
            number: 'FA-2026-0142',
            date: '2026-06-15',
            totalHT: 100,
            totalVAT: 20,
            totalTTC: 120,
            status: 'confirmed',
            lines: [],
            sourceFile: 'Factures/FA-2026-0142.pdf',
            createdAt: '2026-06-15T00:00:00.000Z',
            updatedAt: '2026-06-15T00:00:00.000Z',
          },
        ],
        settings: {
          watchFolder: 'C:\\Users\\ogela\\Documents\\CompaGelato',
          statementFolder: 'C:\\Users\\ogela\\Documents\\CompaGelato\\Releves',
        },
      }),
      'utf8',
    );

    assert.equal(await dataStore.restore(sauvegarde), true);

    // Les données sont bien là.
    assert.equal(dataStore.db.clients.length, 1);
    assert.equal(dataStore.db.documents.length, 1);

    // Mais les dossiers sont ceux de cette machine, pas ceux du poste Windows.
    const watch = dataStore.settings.watchFolder;
    assert.equal(isForeignPath(watch), false, `dossier étranger conservé : ${watch}`);
    assert.equal(watch, defaultWatchFolder());
    assert.equal(dataStore.settings.statementFolder, undefined, 'le dossier des relevés doit retomber sur son défaut');

    // Le chemin de la pièce reste relatif : il suffit de déposer les fichiers
    // dans le dossier de travail de cette machine pour tout retrouver.
    assert.equal(dataStore.db.documents[0].sourceFile, 'Factures/FA-2026-0142.pdf');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
