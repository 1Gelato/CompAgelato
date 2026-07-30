import fsp from 'node:fs/promises';

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

export interface PdfLine {
  page: number;
  y: number;
  text: string;
  items: PdfTextItem[];
}

export interface PdfExtract {
  text: string;
  lines: PdfLine[];
  pages: number;
  /** Pièces jointes du PDF (Factur-X / ZUGFeRD y placent la facture en XML). */
  attachments: { name: string; data: Uint8Array }[];
  info: Record<string, unknown>;
}

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((mod) => {
      // En environnement Node, pdf.js bascule seul sur un « faux worker »
      // (exécution sur le thread courant) : rien à configurer.
      return mod;
    });
  }
  return pdfjsPromise;
}

/** Regroupe les fragments de texte en lignes visuelles, puis en colonnes lisibles. */
function buildLines(items: PdfTextItem[]): PdfLine[] {
  const byPage = new Map<number, PdfTextItem[]>();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const arr = byPage.get(it.page) ?? [];
    arr.push(it);
    byPage.set(it.page, arr);
  }

  const lines: PdfLine[] = [];
  for (const [page, pageItems] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    // Tolérance verticale proportionnelle à la taille de police médiane.
    const heights = pageItems.map((i) => i.height).filter((h) => h > 0).sort((a, b) => a - b);
    const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
    const tol = Math.max(2, medianH * 0.55);

    const buckets: PdfTextItem[][] = [];
    for (const it of [...pageItems].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const bucket = buckets.find((b) => Math.abs(b[0].y - it.y) <= tol);
      if (bucket) bucket.push(it);
      else buckets.push([it]);
    }

    for (const bucket of buckets) {
      bucket.sort((a, b) => a.x - b.x);
      let text = '';
      let prevEnd: number | null = null;
      for (const it of bucket) {
        if (prevEnd !== null) {
          const gap = it.x - prevEnd;
          // Un écart marqué correspond à un changement de colonne.
          if (gap > medianH * 1.2) text += '   ';
          else if (gap > medianH * 0.18 && !text.endsWith(' ')) text += ' ';
        }
        text += it.str;
        prevEnd = it.x + it.width;
      }
      const clean = text.replace(/\s+$/, '');
      if (clean.trim()) lines.push({ page, y: bucket[0].y, text: clean, items: bucket });
    }
  }
  return lines;
}

export async function extractPdf(filePath: string): Promise<PdfExtract> {
  const pdfjs = await loadPdfjs();
  const buf = await fsp.readFile(filePath);
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await task.promise;

  const items: PdfTextItem[] = [];
  const maxPages = Math.min(doc.numPages, 25);
  for (let p = 1; p <= maxPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const raw of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
      if (typeof raw.str !== 'string' || !raw.transform) continue;
      items.push({
        str: raw.str,
        x: raw.transform[4],
        y: raw.transform[5],
        width: raw.width ?? 0,
        height: raw.height || Math.abs(raw.transform[3]) || 10,
        page: p,
      });
    }
    page.cleanup();
  }

  let attachments: { name: string; data: Uint8Array }[] = [];
  try {
    const att = (await doc.getAttachments()) as Record<string, { filename: string; content: Uint8Array }> | null;
    if (att) {
      attachments = Object.values(att)
        .filter((a) => a && a.content)
        .map((a) => ({ name: a.filename, data: a.content }));
    }
  } catch {
    /* PDF sans pièce jointe */
  }

  let info: Record<string, unknown> = {};
  try {
    const meta = await doc.getMetadata();
    info = (meta.info as Record<string, unknown>) ?? {};
  } catch {
    /* ignore */
  }

  const lines = buildLines(items);
  await doc.destroy();

  return {
    text: lines.map((l) => l.text).join('\n'),
    lines,
    pages: doc.numPages,
    attachments,
    info,
  };
}
