import { store } from './store';
import { folderWatcher } from './watcher';
import { ensureWatchFolder, scanFolder } from './services/documents';
import { appVersion } from './handlers';
import { createCompaServer, lanAddresses } from './server';

/**
 * Point d'entrée du serveur CompaGelato — un simple processus Node, sans
 * Electron. À lancer sur le boîtier du dépôt :
 *
 *   COMPAGELATO_DATA_DIR=/srv/compagelato/donnees npm run server
 *
 * Variables d'environnement :
 *   COMPAGELATO_DATA_DIR   dossier de la base et des sauvegardes (défaut ~/.compagelato)
 *   COMPAGELATO_PORT       port d'écoute (défaut 4680)
 *   COMPAGELATO_HOST       adresse d'écoute (défaut 0.0.0.0)
 *   COMPAGELATO_TOKEN      jeton exigé pour l'API et les fichiers (recommandé)
 */
async function main(): Promise<void> {
  store.init();
  ensureWatchFolder(store.settings.watchFolder);

  const running = await createCompaServer({
    port: Number(process.env.COMPAGELATO_PORT) || 4680,
    host: process.env.COMPAGELATO_HOST || '0.0.0.0',
    token: process.env.COMPAGELATO_TOKEN,
  });

  // Le watcher prévient tous les navigateurs connectés via le flux SSE.
  folderWatcher.setNotifier(running.broadcast);

  console.log(`CompaGelato serveur v${appVersion()}`);
  console.log(`  Données   : ${store.dbFile}`);
  console.log(`  Dossier   : ${store.settings.watchFolder}`);
  console.log(`  Accès     : http://localhost:${running.port}`);
  for (const ip of lanAddresses()) console.log(`              http://${ip}:${running.port}`);
  if (!process.env.COMPAGELATO_TOKEN) {
    console.log('  ⚠ Aucun jeton (COMPAGELATO_TOKEN) : toute personne du réseau peut lire les données.');
  }

  // Analyse initiale puis surveillance, comme au démarrage du bureau.
  if (store.settings.autoScan) {
    try {
      const report = await scanFolder();
      if (report.imported || report.updated) running.broadcast('documents-changed', report);
      await folderWatcher.start(store.settings.watchFolder);
    } catch (err) {
      console.error('[serveur] analyse initiale', err);
    }
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} reçu : écriture de la base puis arrêt.`);
    store.flushSync();
    await folderWatcher.stop();
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('uncaughtException', (err) => {
  console.error('[serveur] exception non gérée', err);
  store.flushSync();
});

void main().catch((err) => {
  console.error('[serveur] démarrage impossible :', err);
  process.exit(1);
});
