import { BrowserWindow, Menu, Notification, app, dialog, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActivityEvent } from '@shared/types';
import { store } from './store';
import { registerIpc, setMainWindow } from './ipc';
import { folderWatcher } from './watcher';
import { ensureWatchFolder, scanFolder } from './services/documents';
import {
  connectionConfig,
  initConnection,
  isRemote,
  pingServer,
  useLocalForThisRun,
} from './connection';
import { remoteCall, setSessionLostListener, subscribeEvents } from './remote';
import {
  backOnline,
  hasMirror,
  initOffline,
  isOffline,
  markOffline,
  pullNow,
  schedulePull,
  setTransitionListener,
} from './offline';
import { autoBackupOptionsFromEnv, startAutoBackup } from './services/autoBackup';
import { defaultServerBackupDir, startServerBackup } from './services/serverBackup';
import { applyUpdate, checkForUpdates } from './services/updater';
import { initFolders } from './folders';
import { uploadWatcher } from './services/uploadWatcher';
import { SOURCE_PAGE, SeenActivity, shouldNotify } from './services/desktopNotify';
import { projectRoot } from './handlers';

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
/** Coupe l'abonnement au flux du serveur à la fermeture (mode branché). */
/**
 * Instant de démarrage : sert à repérer qu'une recompilation a eu lieu pendant
 * que cette fenêtre était ouverte — auquel cas ce qu'elle affiche est périmé.
 */
const launchedAt = Date.now();
let stopEvents: (() => void) | null = null;
/** Arrête les sauvegardes automatiques à la fermeture. */
let stopBackups: (() => void) | null = null;

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
          // Branché sur un serveur, ce dossier est sur l'autre machine.
          enabled: !isRemote(),
          click: () => void shell.openPath(ensureWatchFolder(store.settings.watchFolder)),
        },
        {
          label: 'Analyser le dossier maintenant',
          accelerator: 'CmdOrCtrl+R',
          click: async () => {
            // En mode branché c'est le serveur qui analyse ; il préviendra
            // tous les postes par son flux d'événements.
            const report = isRemote()
              ? await remoteCall('documents', 'scan', [{ force: false }])
              : await scanFolder({ force: false });
            mainWindow?.webContents.send('documents-changed', report);
          },
        },
        { type: 'separator' },
        {
          label: 'Sauvegarder la base',
          accelerator: 'CmdOrCtrl+S',
          click: async () => {
            const file = isRemote()
              ? await remoteCall('db', 'backup', [])
              : await store.backup();
            void dialog.showMessageBox(mainWindow ?? undefined!, {
              type: 'info',
              title: 'Sauvegarde',
              message: isRemote() ? 'Sauvegarde enregistrée sur le serveur.' : 'Sauvegarde enregistrée.',
              detail: String(file),
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

/**
 * Serveur configuré mais muet au démarrage.
 *
 * Avec une copie locale, la réponse est simple : **on s'ouvre dessus**, en mode
 * hors-ligne — c'est tout l'objet du miroir, l'application marche en zone
 * blanche et se rattrape ensuite. Le dialogue ne subsiste que pour un poste
 * jamais synchronisé, qui n'a réellement rien à montrer.
 */
async function ensureServerReachable(): Promise<void> {
  for (;;) {
    const { ok, error, authRequired, authenticated } = await pingServer();
    // Serveur joignable mais session à ouvrir : ce n'est pas une panne.
    // L'application s'ouvre et affiche son écran de connexion.
    if (ok && authRequired && !authenticated) return;
    if (ok) return;
    if (hasMirror()) {
      markOffline();
      return;
    }
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'CompaGelato',
      message: 'Le serveur ne répond pas.',
      detail: [
        connectionConfig().serverUrl,
        '',
        error ?? '',
        '',
        'Ce poste n’a pas encore de copie locale : une première synchronisation est nécessaire.',
        'Vous pouvez réessayer, ou travailler sur les données de ce poste.',
        'Attention : ces données-là ne sont pas partagées avec les autres appareils.',
      ].join('\n'),
      buttons: ['Réessayer', 'Travailler sur ce poste', 'Quitter'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 0) continue;
    if (choice === 1) {
      useLocalForThisRun();
      return;
    }
    app.exit(0);
    return;
  }
}

/**
 * La mise à jour vient à l'utilisateur, il ne va pas la chercher.
 *
 * Aller fouiller un écran de réglages pour savoir s'il existe une nouvelle
 * version n'est demandé par aucun autre logiciel, et c'est le meilleur moyen de
 * faire tourner pendant des semaines une copie périmée sans le savoir. La
 * vérification se fait donc seule au démarrage, et ne dérange que lorsqu'il y a
 * effectivement quelque chose à installer.
 */
async function proposeUpdateAtStartup(): Promise<void> {
  let check;
  try {
    check = await checkForUpdates(projectRoot);
  } catch {
    // Pas de réseau, pas de dépôt git : le démarrage n'a pas à en souffrir.
    return;
  }
  if (!check.supported || !check.available) return;

  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const many = check.behind > 1;
  const { response } = await dialog.showMessageBox(window!, {
    type: 'info',
    title: 'Mise à jour disponible',
    message:
      check.behind > 0
        ? `${check.behind} amélioration${many ? 's' : ''} disponible${many ? 's' : ''}`
        : 'Une reconstruction est nécessaire',
    detail:
      check.behind > 0
        ? check.changes.slice(0, 8).map((c) => `• ${c}`).join('\n')
        : 'Le code est à jour, mais le logiciel qui s’exécute a été compilé avant : ' +
          'les nouveautés ne s’afficheront qu’après reconstruction.',
    buttons: ['Installer maintenant', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  const result = await applyUpdate(projectRoot, (step) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toast', { tone: 'info', title: step });
    }
  });

  if (!result.success) {
    await dialog.showMessageBox(window!, {
      type: 'error',
      title: 'Mise à jour impossible',
      message: result.message,
      detail: result.localChanges?.length
        ? `Fichiers modifiés sur ce poste :\n${result.localChanges.slice(0, 10).join('\n')}\n\n` +
          'Réglages → Mises à jour propose « Réparer et installer » pour les rétablir.'
        : undefined,
      buttons: ['OK'],
    });
    return;
  }

  const { response: restart } = await dialog.showMessageBox(window!, {
    type: 'info',
    title: 'Mise à jour installée',
    message: 'CompaGelato doit redémarrer pour utiliser la nouvelle version.',
    buttons: ['Redémarrer maintenant', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
  });
  if (restart === 0) {
    store.flushSync();
    app.relaunch();
    app.exit(0);
  }
}

/* ------------------------------------------------------------------ */
/* Notifications du système                                             */
/* ------------------------------------------------------------------ */

/**
 * Qui je suis, vu du serveur.
 *
 * Indispensable pour écarter mes propres gestes : le serveur annonce à tout le
 * monde, y compris à celui qui vient d'agir. Relu à chaque ouverture du flux —
 * une session peut avoir changé de compte entre-temps. En cas d'échec on garde
 * la valeur précédente : mieux vaut un filtre un peu vieux que plus de filtre
 * du tout.
 */
let myUserId: string | null = null;
const seenActivity = new SeenActivity();

async function refreshIdentity(): Promise<void> {
  try {
    const status = (await remoteCall('auth', 'status', [])) as {
      identity?: { userId?: string } | null;
    };
    myUserId = status?.identity?.userId ?? null;
  } catch {
    /* serveur injoignable : on garde ce qu'on savait */
  }
}

function showActivity(event: ActivityEvent): void {
  if (!event?.source || !event.title) return;
  if (!Notification.isSupported()) return;
  if (!seenActivity.accept(event)) return;

  const focused = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
  const decision = shouldNotify(event, {
    myUserId,
    windowFocused: focused,
    settings: store.settings.desktopNotify,
  });
  if (!decision) return;

  const notification = new Notification({ title: event.title, body: event.text });
  // Cliquer sur la bulle amène là où la nouveauté se trouve : une notification
  // qui n'ouvre rien oblige à retrouver soi-même ce dont elle parlait.
  notification.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('go-to-page', SOURCE_PAGE[event.source]);
  });
  notification.show();
}

app.whenReady().then(async () => {
  // Windows rattache les bulles à cet identifiant : sans lui, une application
  // non empaquetée voit ses notifications attribuées à « electron.exe », voire
  // silencieusement ignorées.
  if (process.platform === 'win32') app.setAppUserModelId('fr.ogelato.compagelato');

  const dataDir = app.getPath('userData');
  // Le magasin ne connaît pas Electron : on lui indique où vivre.
  store.init({
    dataDir,
    documentsDir: (() => {
      try {
        return app.getPath('documents');
      } catch {
        return path.join(app.getPath('home'), 'Documents');
      }
    })(),
  });
  initConnection(dataDir);
  initFolders(dataDir);
  if (isRemote()) {
    initOffline(dataDir);
    await ensureServerReachable();
  }

  // En mode branché, le dossier surveillé est celui du serveur : rien à créer
  // ni à analyser ici, c'est lui qui s'en charge pour tout le monde.
  if (!isRemote()) ensureWatchFolder(store.settings.watchFolder);
  registerIpc();
  buildMenu();

  mainWindow = createWindow();
  setMainWindow(mainWindow);

  // Quelques secondes après l'ouverture : le temps que la fenêtre soit peinte,
  // pour ne pas poser une boîte de dialogue sur un écran encore vide.
  mainWindow.webContents.once('did-finish-load', () => {
    const timer = setTimeout(() => void proposeUpdateAtStartup(), 4000);
    timer.unref?.();
  });

  if (isRemote()) {
    const toWindow = (channel: string, payload: unknown) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    };

    // Le serveur exige une connexion : l'écran de connexion doit revenir de
    // lui-même. Sans cela — c'est le cas au moment précis où le premier compte
    // vient d'être créé — l'utilisateur ne voit qu'un « Connexion requise » en
    // rouge, sans que rien ne lui propose de se connecter.
    setSessionLostListener(() => toWindow('session-lost', {}));

    // Les transitions hors-ligne / en ligne se racontent à l'écran, et le
    // retour du réseau rafraîchit les tableaux (le miroir vient de changer).
    setTransitionListener((online, replayed, failed) => {
      if (!online) {
        toWindow('toast', {
          tone: 'warn',
          title: 'Serveur injoignable — travail hors ligne',
          text: 'Vos modifications sont conservées sur ce poste et seront rejouées à la reconnexion.',
        });
        return;
      }
      toWindow('documents-changed', {});
      if (replayed || failed) {
        toWindow('toast', {
          tone: failed ? 'warn' : 'success',
          title: 'Connexion au serveur rétablie',
          text: [
            replayed ? `${replayed} modification(s) rejouée(s).` : '',
            failed
              ? `${failed} refusée(s) — voir Réglages → Synchronisation.`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
      }
    });

    // Les mêmes trois canaux qu'en local, mais poussés par le serveur. Chaque
    // événement signale que la base a bougé : le miroir suit.
    stopEvents = subscribeEvents(
      (channel, payload) => {
        schedulePull();
        toWindow(channel, payload);
        if (channel === 'activity') showActivity(payload as ActivityEvent);
      },
      {
        // Flux rouvert = serveur revenu : rejouer la file, resynchroniser.
        onOpen: () => {
          if (isOffline()) void backOnline();
          // L'identité peut avoir changé depuis la dernière ouverture (autre
          // compte, session reprise) : sans elle, on ne sait plus distinguer
          // ses propres gestes de ceux des autres.
          void refreshIdentity();
        },
      },
    );
    void refreshIdentity();

    // Synchronisation de départ, puis d'entretien — un delta vide est minuscule.
    if (!isOffline()) {
      void pullNow().catch(() => markOffline());
    }
    // Entretien : synchronisation régulière quand tout va bien, tentative de
    // reconnexion quand le serveur a lâché. Sans cette seconde branche, un
    // poste passé hors ligne y restait : seule la réouverture du flux
    // d'événements le ramenait, et si ce flux n'avait jamais coupé — un simple
    // appel en délai dépassé suffit à passer hors ligne — plus rien ne le
    // rattrapait. Il fallait alors réenregistrer l'adresse et redémarrer.
    const upkeep = setInterval(
      () => {
        if (isOffline()) void backOnline();
        else schedulePull();
      },
      60_000,
    );
    upkeep.unref();

    // Copie de sécurité du poste. Le miroir hors-ligne permet de *travailler*
    // sans le serveur ; il ne permettrait pas de le remonter. Ce dossier-ci,
    // lui, se restaure — c'est ce qui fait que les données existent vraiment à
    // deux endroits.
    stopBackups = startServerBackup({ dir: defaultServerBackupDir(dataDir) });

    // Les dossiers de comptabilité de ce poste montent tout seuls au serveur.
    // C'est le pont qui manquait : le serveur surveille le sien, pas celui où
    // le logiciel de compta dépose réellement ses PDF.
    uploadWatcher.setListener(({ sent, failed, offline }) => {
      if (sent) {
        toWindow('documents-changed', { imported: sent });
        toWindow('toast', {
          tone: 'success',
          title: `${sent} pièce${sent > 1 ? 's' : ''} envoyée${sent > 1 ? 's' : ''} au serveur`,
        });
      }
      if (failed.length && !offline) {
        toWindow('toast', {
          tone: 'warn',
          title: `${failed.length} fichier(s) refusé(s)`,
          text: failed[0]?.error,
        });
      }
    });
    void uploadWatcher.start();
  } else {
    folderWatcher.setNotifier((channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    });

    // Poste autonome : c'est lui qui détient les données, donc lui qui les
    // sauvegarde — sans qu'on ait à y penser.
    stopBackups = startAutoBackup(autoBackupOptionsFromEnv());

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
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      setMainWindow(mainWindow);
    }
  });
});

/**
 * Relancer le raccourci alors que l'application tourne déjà.
 *
 * Le raccourci recompile avant de lancer (`npm start`). Une seule instance étant
 * autorisée, le nouveau processus quitte aussitôt et Windows remet l'ancienne
 * fenêtre au premier plan : le logiciel vient d'être reconstruit, mais celui
 * qu'on regarde a chargé l'ancienne interface en mémoire et n'en changera pas.
 *
 * De l'extérieur c'est indiscernable d'un redémarrage réussi — on croit avoir
 * relancé, on voit l'ancien écran, et l'on conclut que la mise à jour ne marche
 * pas. On le dit donc, et on propose le vrai redémarrage.
 */
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();

  const index = path.join(dirname, '../renderer/index.html');
  let rebuiltSinceLaunch = false;
  try {
    rebuiltSinceLaunch = fs.statSync(index).mtimeMs > launchedAt;
  } catch {
    return;
  }
  if (!rebuiltSinceLaunch) return;

  void dialog
    .showMessageBox(mainWindow, {
      type: 'info',
      title: 'Nouvelle version compilée',
      message: 'CompaGelato a été mis à jour pendant que cette fenêtre était ouverte.',
      detail:
        'La fenêtre affiche encore la version précédente. Redémarrez pour utiliser la nouvelle.',
      buttons: ['Redémarrer maintenant', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response !== 0) return;
      store.flushSync();
      app.relaunch();
      app.exit(0);
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopEvents?.();
  stopBackups?.();
  void uploadWatcher.stop();
  store.flushSync();
  void folderWatcher.stop();
});

process.on('uncaughtException', (err) => {
  console.error('[main] exception non gérée', err);
  store.flushSync();
});
