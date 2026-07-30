import { BrowserWindow, Menu, app, dialog, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from './store';
import { registerIpc, setMainWindow } from './ipc';
import { folderWatcher } from './watcher';
import { ensureWatchFolder, scanFolder } from './services/documents';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

// Interface entièrement en français : les champs natifs (sélecteur de date,
// menus contextuels) doivent suivre, quelle que soit la langue du système.
app.commandLine.appendSwitch('lang', 'fr-FR');

// Une seule instance : un second lancement réactive la fenêtre existante.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    title: 'CompaGelato',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // Les liens externes s'ouvrent dans le navigateur, jamais dans l'application.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const isDev = devServerUrl && url.startsWith(devServerUrl);
    if (!isDev) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadFile(path.join(dirname, '../renderer/index.html'));
  }

  return window;
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'CompaGelato',
            submenu: [
              { role: 'about' as const, label: 'À propos de CompaGelato' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: 'Masquer CompaGelato' },
              { role: 'hideOthers' as const, label: 'Masquer les autres' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: 'Quitter CompaGelato' },
            ],
          },
        ]
      : []),
    {
      label: 'Fichier',
      submenu: [
        {
          label: 'Ouvrir le dossier surveillé',
          accelerator: 'CmdOrCtrl+O',
          click: () => void shell.openPath(ensureWatchFolder(store.settings.watchFolder)),
        },
        {
          label: 'Analyser le dossier maintenant',
          accelerator: 'CmdOrCtrl+R',
          click: async () => {
            const report = await scanFolder({ force: false });
            mainWindow?.webContents.send('documents-changed', report);
          },
        },
        { type: 'separator' },
        {
          label: 'Sauvegarder la base',
          accelerator: 'CmdOrCtrl+S',
          click: async () => {
            const file = await store.backup();
            void dialog.showMessageBox(mainWindow ?? undefined!, {
              type: 'info',
              title: 'Sauvegarde',
              message: 'Sauvegarde enregistrée.',
              detail: file,
              buttons: ['OK'],
            });
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Fermer' } : { role: 'quit', label: 'Quitter' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload', label: 'Recharger' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Taille réelle' },
        { role: 'zoomIn', label: 'Agrandir' },
        { role: 'zoomOut', label: 'Réduire' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
      ],
    },
    {
      label: 'Aide',
      submenu: [
        {
          label: 'Emplacement des données',
          click: () => void shell.openPath(app.getPath('userData')),
        },
        {
          label: 'Guide d’utilisation',
          click: () => {
            void dialog.showMessageBox(mainWindow ?? undefined!, {
              type: 'info',
              title: 'CompaGelato',
              message: 'Comment ça marche',
              detail: [
                '1. Déposez vos factures et devis dans le dossier surveillé',
                `   (${store.settings.watchFolder}).`,
                '2. CompaGelato les lit automatiquement et remplit les tableaux.',
                '3. Importez votre liste clients depuis Clients > Importer.',
                '4. Saisissez votre stock de consommables, il se décrémente',
                '   à partir des lignes de vos factures.',
                '5. Onglet Tournées : construisez la feuille de route, épinglez',
                '   les arrêts prioritaires, optimisez et envoyez sur le téléphone.',
              ].join('\n'),
              buttons: ['OK'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  store.init();
  ensureWatchFolder(store.settings.watchFolder);
  registerIpc();
  buildMenu();

  mainWindow = createWindow();
  setMainWindow(mainWindow);
  folderWatcher.attach(mainWindow);

  // Analyse initiale et surveillance en arrière-plan, sans bloquer l'ouverture.
  mainWindow.webContents.once('did-finish-load', () => {
    void (async () => {
      try {
        if (store.settings.autoScan) {
          const report = await scanFolder();
          if (report.imported || report.updated) {
            mainWindow?.webContents.send('documents-changed', report);
          }
          await folderWatcher.start(store.settings.watchFolder);
        }
      } catch (err) {
        console.error('[main] analyse initiale', err);
      }
    })();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      setMainWindow(mainWindow);
      folderWatcher.attach(mainWindow);
    }
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  store.flushSync();
  void folderWatcher.stop();
});

process.on('uncaughtException', (err) => {
  console.error('[main] exception non gérée', err);
  store.flushSync();
});
