import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Impression d'une mise en page fabriquée par l'application.
 *
 * Les documents comptables s'impriment depuis leur fichier d'origine ; les
 * bons de livraison et les cahiers, eux, n'existent qu'en base — il faut
 * composer la page. Elle est rendue dans un cadre invisible avec sa propre
 * feuille de style noir sur blanc, puis envoyée à l'imprimante : l'écran ne
 * bouge pas, et les styles de l'application (thème sombre compris) ne
 * déteignent jamais sur le papier.
 *
 * Fonctionne à l'identique dans l'application de bureau et dans le
 * navigateur (mode serveur) : c'est le dialogue d'impression du système.
 */

const PRINT_CSS = `
  * { box-sizing: border-box; }
  body {
    font: 12.5px/1.5 "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif;
    color: #111;
    margin: 0;
    padding: 4px 2px;
  }
  h1 { font-size: 19px; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 13px; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: 0.05em; color: #444; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { border: 1px solid #bbb; padding: 5px 8px; text-align: left; vertical-align: top; font-size: 12px; }
  th { background: #f1f1f1; font-weight: 600; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tr { break-inside: avoid; }
  .entete { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #111; padding-bottom: 10px; }
  .entete .societe { font-size: 15px; font-weight: 700; }
  .muted { color: #555; }
  .tiny { font-size: 11px; }
  .blocs { display: flex; gap: 24px; margin-top: 12px; }
  .bloc { flex: 1; border: 1px solid #ccc; border-radius: 6px; padding: 8px 10px; }
  .bloc .titre { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; margin-bottom: 3px; }
  .signatures { display: flex; gap: 24px; margin-top: 20px; break-inside: avoid; }
  .signature { flex: 1; border: 1px solid #ccc; border-radius: 6px; padding: 8px 10px; }
  .signature svg { width: 100%; height: auto; display: block; }
  .pied { margin-top: 22px; padding-top: 8px; border-top: 1px solid #ccc; font-size: 10.5px; color: #666; }
  @page { margin: 14mm; }
`;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Compose la page et ouvre le dialogue d'impression.
 *
 * `window.__COMPAGELATO_PRINT_TEST__` garde le cadre en place sans imprimer :
 * c'est ainsi que la suite de vérification lit ce qui serait parti au papier —
 * on ne peut pas cliquer « Imprimer » dans un dialogue du système depuis un
 * test.
 */
export function printView(title: string, view: ReactElement): void {
  const html = renderToStaticMarkup(view);

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset.print = 'compagelato';
  frame.style.position = 'fixed';
  frame.style.right = '100%';
  frame.style.bottom = '100%';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${html}</body></html>`,
  );
  doc.close();

  if ((window as unknown as { __COMPAGELATO_PRINT_TEST__?: boolean }).__COMPAGELATO_PRINT_TEST__) {
    return;
  }

  const cleanup = () => setTimeout(() => frame.remove(), 300);
  win.addEventListener('afterprint', cleanup);
  // Petit délai : la page doit être mise en forme avant d'être mesurée.
  setTimeout(() => {
    win.focus();
    win.print();
  }, 80);
  // Filet : si `afterprint` ne vient jamais (annulation étrange), on nettoie.
  setTimeout(() => frame.remove(), 120_000);
}
