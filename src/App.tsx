import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ScanReport, Settings as SettingsType } from '@shared/types';
import { Icons, ToastProvider, useToast } from './components/ui';
import { refreshAll, useDocuments, useProducts, useSettings } from './lib/data';
import { Dashboard } from './pages/Dashboard';
import { Documents } from './pages/Documents';
import { Clients } from './pages/Clients';
import { Stock } from './pages/Stock';
import { Routes } from './pages/Routes';
import { Banque } from './pages/Banque';
import { Settings } from './pages/Settings';
import { errorMessage } from './lib/data';

type Page = 'dashboard' | 'documents' | 'clients' | 'stock' | 'routes' | 'banque' | 'settings';

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
    title: 'Stock de consommables',
    subtitle: 'Déduit automatiquement des lignes de vos factures',
  },
  {
    id: 'routes',
    label: 'Tournées',
    icon: Icons.routes,
    title: 'Tournées de livraison',
    subtitle: 'Feuille de route, optimisation du trajet et coût réel',
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

function Shell() {
  const [page, setPage] = useState<Page>('dashboard');
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; file: string } | null>(null);
  const { data: settings } = useSettings();
  const { data: documents } = useDocuments();
  const { data: products } = useProducts();
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
    return () => {
      offChanged();
      offProgress();
    };
  }, [toast]);

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
    const pending = documents.filter(
      (d) => !d.stockApplied && d.kind !== 'quote' && d.status !== 'cancelled',
    ).length;
    const low = products.filter((p) => !p.archived && p.minQty > 0 && p.qtyOnHand < p.minQty).length;
    return { documents: pending, stock: low };
  }, [documents, products]);

  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];

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
          {PAGES.map((item) => {
            const Icon = item.icon;
            const badge =
              item.id === 'documents' ? badges.documents : item.id === 'stock' ? badges.stock : 0;
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
              <button
                className="navitem tiny"
                style={{ padding: '2px 0', color: 'var(--text-tertiary)' }}
                onClick={() => settings && window.api.app.openPath(settings.watchFolder)}
                title={settings?.watchFolder}
              >
                <span className="truncate">{shortenPath(settings?.watchFolder ?? '')}</span>
              </button>
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
          {page === 'banque' && <Banque />}
          {page === 'settings' && (
            <Settings onScan={scan} scanning={scanning} onThemeChange={applyTheme} />
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

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
