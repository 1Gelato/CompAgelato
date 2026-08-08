import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { awaitsStock, type ScanReport, type Settings as SettingsType } from '@shared/types';
import type { AuthIdentity, ChannelName } from '@shared/api';
import { mayCall } from '@shared/api';
import { Icons, Spinner, ToastProvider, useToast } from './components/ui';
import { setSessionLostHandler } from './lib/httpApi';
import { Login } from './pages/Login';
import {
  refreshAll,
  setCurrentRole,
  useAppInfo,
  useDocuments,
  useProducts,
  useRegisterEntries,
  useSettings,
} from './lib/data';
import { Dashboard } from './pages/Dashboard';
import { Documents } from './pages/Documents';
import { Clients } from './pages/Clients';
import { Stock } from './pages/Stock';
import { Routes } from './pages/Routes';
import { Banque } from './pages/Banque';
import { Cahiers } from './pages/Cahiers';
import { Settings } from './pages/Settings';
import { errorMessage } from './lib/data';

type Page = 'dashboard' | 'documents' | 'clients' | 'stock' | 'routes' | 'cahiers' | 'banque' | 'settings';

const PAGES: {
  id: Page;
  label: string;
  icon: (props: { size?: number }) => ReactElement;
  title: string;
  subtitle: string;
}[] = [
  {
    id: 'dashboard',
    label: 'Tableau de bord',
    icon: Icons.dashboard,
    title: 'Tableau de bord',
    subtitle: 'Vue d’ensemble de votre activité',
  },
  {
    id: 'documents',
    label: 'Documents',
    icon: Icons.documents,
    title: 'Factures et devis',
    subtitle: 'Lus automatiquement depuis votre dossier de comptabilité',
  },
  {
    id: 'clients',
    label: 'Clients',
    icon: Icons.clients,
    title: 'Clients',
    subtitle: 'Carnet d’adresses et rattachement des pièces comptables',
  },
  {
    id: 'stock',
    label: 'Stock',
    icon: Icons.stock,
    title: 'Stock',
    subtitle: 'Consommables, machines et pièces détachées — déduit de vos factures',
  },
  {
    id: 'routes',
    label: 'Tournées',
    icon: Icons.routes,
    title: 'Tournées de livraison',
    subtitle: 'Feuille de route, optimisation du trajet et coût réel',
  },
  {
    id: 'cahiers',
    label: 'Cahiers',
    icon: Icons.book,
    title: 'Cahiers',
    subtitle: 'SAV, consommables et événementiel — vos trois cahiers, au même endroit',
  },
  {
    id: 'banque',
    label: 'Banque',
    icon: Icons.bank,
    title: 'Relevés de compte',
    subtitle: 'Opérations bancaires, rapprochement des factures et trésorerie',
  },
  {
    id: 'settings',
    label: 'Réglages',
    icon: Icons.settings,
    title: 'Réglages',
    subtitle: 'Dossier surveillé, véhicules, données',
  },
];

function applyTheme(theme: SettingsType['theme']): void {
  const root = document.documentElement;
  if (theme === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'dark' : 'light';
  } else {
    root.dataset.theme = theme;
  }
}

/**
 * Le canal qui décide de la visibilité de chaque écran.
 *
 * Le masquage n'est qu'un confort : le serveur refuse de toute façon les appels
 * non autorisés. Mais afficher au livreur un onglet « Banque » qui n'affiche
 * que des erreurs serait une mauvaise façon de lui dire qu'il n'y a pas droit.
 *
 * Les Réglages restent visibles pour tous : c'est là qu'on change son mot de
 * passe et qu'on se déconnecte. Les cartes sensibles y sont masquées une à une.
 */
const PAGE_CHANNEL: Record<Page, ChannelName | null> = {
  dashboard: 'stats:dashboard',
  documents: 'documents:list',
  clients: 'clients:list',
  stock: 'products:list',
  routes: 'routes:list',
  cahiers: 'registers:list',
  banque: 'bank:list',
  settings: null,
};

function Shell({
  identity,
  onSignedOut,
}: {
  identity: AuthIdentity | null;
  onSignedOut: () => void;
}) {
  const [page, setPage] = useState<Page>('dashboard');
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; file: string } | null>(null);
  const { data: settings } = useSettings();
  const { data: appInfo } = useAppInfo();
  const { data: documents } = useDocuments();
  const { data: products } = useProducts();
  const { data: registerEntries } = useRegisterEntries();
  const toast = useToast();

  /* Thème -------------------------------------------------------- */
  useEffect(() => {
    const theme = settings?.theme ?? 'system';
    applyTheme(theme);
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => applyTheme('system');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [settings?.theme]);

  /* Événements poussés par le processus principal ----------------- */
  useEffect(() => {
    const offChanged = window.api.on('documents-changed', (payload: ScanReport & { seeded?: boolean }) => {
      refreshAll();
      if (payload?.imported || payload?.updated) {
        toast.push({
          tone: 'success',
          title: 'Dossier mis à jour',
          text: `${payload.imported} nouveau(x) document(s), ${payload.updated} mis à jour.`,
        });
      }
    });
    const offProgress = window.api.on('scan-progress', (payload: { current: number; total: number; file: string }) => {
      setProgress(payload);
      if (payload.current >= payload.total) setTimeout(() => setProgress(null), 700);
    });
    // Messages poussés par le processus principal : passage hors-ligne,
    // reconnexion, étapes de mise à jour.
    const offToast = window.api.on('toast', (payload: { tone?: string; title: string; text?: string }) => {
      toast.push({
        tone: (payload.tone as 'success' | 'warn' | 'error' | 'info' | undefined) ?? 'info',
        title: payload.title,
        text: payload.text,
      });
    });
    // Clic sur une notification du système : la page annoncée s'ouvre. Le
    // processus principal ne connaît pas les droits de l'utilisateur, donc on
    // vérifie ici que la page lui est bien accessible.
    const offGoTo = window.api.on('go-to-page', (target: string) => {
      if (PAGES.some((p) => p.id === target)) setPage(target as Page);
    });
    return () => {
      offGoTo();
      offChanged();
      offProgress();
      offToast();
    };
  }, [toast]);

  /* État de synchronisation (mode branché uniquement) ------------------ */
  const [syncInfo, setSyncInfo] = useState<{ online: boolean; pending: number; failed: number } | null>(null);
  useEffect(() => {
    if (appInfo?.mode !== 'remote') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await window.api.sync.status();
        if (!cancelled) {
          setSyncInfo({
            online: status.online,
            pending: status.pending.length,
            failed: status.failed.length,
          });
        }
      } catch {
        /* mode local ou serveur : pas de file d'attente ici */
      }
    };
    void poll();
    const timer = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [appInfo?.mode]);

  const scan = useCallback(
    async (force = false) => {
      setScanning(true);
      try {
        const report = await window.api.documents.scan({ force });
        refreshAll();
        const details: string[] = [];
        if (report.imported) details.push(`${report.imported} importé(s)`);
        if (report.updated) details.push(`${report.updated} mis à jour`);
        if (report.skipped) details.push(`${report.skipped} inchangé(s)`);
        if (report.failed) details.push(`${report.failed} en échec`);
        toast.push({
          tone: report.failed ? 'warn' : 'success',
          title: report.scanned
            ? `${report.scanned} fichier(s) analysé(s)`
            : 'Aucun fichier trouvé dans le dossier',
          text: details.join(' · ') || undefined,
        });
        if (report.errors.length) {
          toast.push({
            tone: 'error',
            title: 'Fichiers non lus',
            text: report.errors.map((e) => `${e.file} : ${e.message}`).join(' | '),
          });
        }
      } catch (err) {
        toast.push({ tone: 'error', title: 'Analyse impossible', text: errorMessage(err) });
      } finally {
        setScanning(false);
        setProgress(null);
      }
    },
    [toast],
  );

  const badges = useMemo(() => {
    const pending = documents.filter(awaitsStock).length;
    const low = products.filter((p) => !p.archived && p.minQty > 0 && p.qtyOnHand < p.minQty).length;
    // « À traiter » au sens des cahiers : demandes et interventions ouvertes.
    const open = registerEntries.filter((e) => e.status === 'open').length;
    return { documents: pending, stock: low, cahiers: open };
  }, [documents, products, registerEntries]);

  // Sans identité (application de bureau sur ses propres données), tout est
  // visible : il n'y a ni compte ni rôle, l'utilisateur est chez lui.
  const visiblePages = useMemo(
    () =>
      PAGES.filter((item) => {
        if (!identity) return true;
        const channel = PAGE_CHANNEL[item.id];
        return !channel || mayCall(identity.role, channel);
      }),
    [identity],
  );

  // Le tableau de bord est refusé au livreur : il faut donc atterrir ailleurs.
  useEffect(() => {
    if (!visiblePages.some((p) => p.id === page)) setPage(visiblePages[0]?.id ?? 'settings');
  }, [visiblePages, page]);

  const current = visiblePages.find((p) => p.id === page) ?? visiblePages[0] ?? PAGES[0];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <div className="sidebar__logo">
            <Icons.box size={15} />
          </div>
          <div className="sidebar__name">CompaGelato</div>
        </div>

        <nav className="sidebar__nav">
          {visiblePages.map((item) => {
            const Icon = item.icon;
            const badge =
              item.id === 'documents'
                ? badges.documents
                : item.id === 'stock'
                  ? badges.stock
                  : item.id === 'cahiers'
                    ? badges.cahiers
                    : 0;
            return (
              <button
                key={item.id}
                className={`navitem ${page === item.id ? 'navitem--active' : ''}`}
                onClick={() => setPage(item.id)}
              >
                <span className="navitem__icon">
                  <Icon size={16} />
                </span>
                {item.label}
                {badge > 0 && (
                  <span
                    className={`navitem__badge ${item.id === 'stock' ? 'navitem__badge--alert' : ''}`}
                  >
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="sidebar__footer">
          {/* Hors ligne, ou file d'attente non vide : le poste doit le voir. */}
          {syncInfo && (!syncInfo.online || syncInfo.pending > 0 || syncInfo.failed > 0) && (
            <button
              className={`syncpill ${syncInfo.online ? 'syncpill--pending' : 'syncpill--offline'}`}
              onClick={() => setPage('settings')}
              title="Voir la synchronisation dans les Réglages"
            >
              {syncInfo.online ? '' : 'Hors ligne'}
              {syncInfo.pending > 0 &&
                `${syncInfo.online ? '' : ' · '}${syncInfo.pending} en attente`}
              {syncInfo.failed > 0 && ` · ${syncInfo.failed} refusée(s)`}
            </button>
          )}
          {progress ? (
            <>
              <div className="truncate">Analyse : {progress.file}</div>
              <div className="progress">
                <div
                  className="progress__bar"
                  style={{ width: `${Math.round((progress.current / Math.max(1, progress.total)) * 100)}%` }}
                />
              </div>
            </>
          ) : (
            <>
              <div className="truncate" title={settings?.watchFolder}>
                {settings?.autoScan ? 'Dossier surveillé' : 'Surveillance désactivée'}
              </div>
              {appInfo && !appInfo.localFolders ? (
                // Dossier situé sur le serveur : il n'y a rien à ouvrir ici.
                <div
                  className="truncate tiny"
                  style={{ padding: '2px 0', color: 'var(--text-tertiary)' }}
                  title={`${settings?.watchFolder ?? ''} (sur le serveur)`}
                >
                  {shortenPath(settings?.watchFolder ?? '')}
                </div>
              ) : (
                <button
                  className="navitem tiny"
                  style={{ padding: '2px 0', color: 'var(--text-tertiary)' }}
                  onClick={() => settings && window.api.app.openPath(settings.watchFolder)}
                  title={settings?.watchFolder}
                >
                  <span className="truncate">{shortenPath(settings?.watchFolder ?? '')}</span>
                </button>
              )}
            </>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar__titles">
            <h1>{current.title}</h1>
            <div className="topbar__subtitle">{current.subtitle}</div>
          </div>
        </header>

        <div className="content">
          {page === 'dashboard' && <Dashboard onNavigate={(p) => setPage(p as Page)} />}
          {page === 'documents' && <Documents scanning={scanning} onScan={scan} />}
          {page === 'clients' && <Clients />}
          {page === 'stock' && <Stock />}
          {page === 'routes' && <Routes />}
          {page === 'cahiers' && <Cahiers />}
          {page === 'banque' && <Banque />}
          {page === 'settings' && (
            <Settings
              onScan={scan}
              scanning={scanning}
              onThemeChange={applyTheme}
              identity={identity}
              onSignedOut={onSignedOut}
            />
          )}
        </div>
      </main>
    </div>
  );
}

/** Raccourcit un chemin long en gardant le début et la fin. */
function shortenPath(path: string): string {
  if (path.length <= 34) return path;
  const parts = path.split(/[/\\]/);
  if (parts.length <= 2) return path;
  return `${parts[0]}…${parts.slice(-2).join('\\')}`;
}

/**
 * Porte d'entrée.
 *
 * Trois situations, distinguées par le serveur lui-même :
 *
 * - aucun compte n'existe (application de bureau locale, ou serveur resté au
 *   jeton partagé) : on entre directement, comme avant ;
 * - des comptes existent et une session est ouverte : on entre avec un rôle ;
 * - des comptes existent sans session : écran de connexion.
 *
 * Un échec de cet appel n'est jamais bloquant : si le serveur ne répond pas,
 * l'application s'ouvre quand même et affichera ses erreurs écran par écran.
 * Une porte close sur un diagnostic incertain serait pire.
 */
function Gate() {
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const [state, setState] = useState<'checking' | 'login' | 'open'>('checking');

  const check = useCallback(async () => {
    try {
      const status = await window.api.auth.status();
      // Le rôle est posé avant tout rendu : les écrans ne demanderont pas ce à
      // quoi ils n'ont pas droit.
      setCurrentRole(status.identity?.role ?? null);
      setIdentity(status.identity);
      setState(status.required && !status.identity ? 'login' : 'open');
    } catch {
      setState('open');
    }
  }, []);

  useEffect(() => {
    void check();
    // Session expirée ou révoquée pendant l'utilisation : retour à l'écran de
    // connexion plutôt qu'une cascade d'erreurs incompréhensibles.
    const lost = () => {
      setCurrentRole(null);
      setIdentity(null);
      setState('login');
    };
    // Navigateur : le drapeau se lit dans la réponse HTTP.
    setSessionLostHandler(lost);
    // Bureau branché : l'IPC ne transporte qu'un message d'erreur, le processus
    // principal pousse donc l'information par un événement.
    return window.api.on('session-lost', lost);
  }, [check]);

  if (state === 'checking') {
    return (
      <div className="loginwrap">
        <Spinner size={22} />
      </div>
    );
  }

  if (state === 'login') {
    return (
      <Login
        onDone={(next) => {
          setCurrentRole(next.role);
          setIdentity(next);
          setState('open');
          refreshAll();
        }}
      />
    );
  }

  return (
    <Shell
      identity={identity}
      onSignedOut={() => {
        setCurrentRole(null);
        setIdentity(null);
        setState('login');
      }}
    />
  );
}

export function App() {
  return (
    <ToastProvider>
      <Gate />
    </ToastProvider>
  );
}
