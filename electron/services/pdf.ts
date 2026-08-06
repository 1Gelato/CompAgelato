import fsp from 'node:fs/promises';

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
  /** Texte incliné : un filigrane « BROUILLON » en diagonale, jamais une donnée. */
  rotated?: boolean;
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

/**
 * Mots que l'on n'imprime en très gros que pour tamponner un document :
 * « BROUILLON », « DUPLICATA », « SPÉCIMEN »… Une désignation d'article ne
 * s'écrit jamais au double de la taille du reste de la page.
 */
const WATERMARK_WORDS =
  /^(brouillon|provisoire|duplicata|copie|sp[ée]cimen|specimen|annul[ée]{1,2}|non\s*valable|sans\s*valeur|draft|void|paid)$/i;

/**
 * Décide si un fragment de texte est un filigrane décoratif plutôt qu'une
 * donnée. Deux signatures, volontairement étroites pour ne rien perdre d'utile :
 * le texte est incliné (un filigrane en diagonale), ou c'est un mot de tampon
 * imprimé bien plus gros que le corps de la page.
 */
export function isWatermarkItem(item: PdfTextItem, medianHeight: number): boolean {
  if (item.rotated) return true;
  const text = item.str.trim();
  if (!text) return false;
  if (item.height < medianHeight * 1.8) return false;
  return WATERMARK_WORDS.test(text.replace(/\s+/g, ' '));
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
    /*
     * Une page entièrement inclinée n'est pas tamponnée : c'est une page en
     * paysage produite par rotation. On ne retire le texte incliné que s'il
     * reste minoritaire — sinon on viderait la page de son contenu.
     */
    const rotatedCount = pageItems.filter((i) => i.rotated).length;
    const dropRotated = rotatedCount * 2 < pageItems.length;
    const upright = dropRotated ? pageItems.filter((i) => !i.rotated) : pageItems;

    // Tolérance verticale proportionnelle à la taille de police médiane, mesurée
    // sur le corps du document (filigranes exclus, ils fausseraient la médiane).
    const heights = upright.map((i) => i.height).filter((h) => h > 0).sort((a, b) => a - b);
    const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
    const tol = Math.max(2, medianH * 0.55);

    const kept = upright.filter((it) => !isWatermarkItem(it, medianH));

    const buckets: PdfTextItem[][] = [];
    for (const it of [...kept].sort((a, b) => b.y - a.y || a.x - b.x)) {
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
      // Matrice [a b c d e f] : b et c portent l'inclinaison. Un texte droit a
      // b = c = 0 ; au-delà d'environ 5°, c'est un filigrane en diagonale.
      const [a, b, c, d] = raw.transform;
      const rotated = Math.abs(b) > Math.abs(a) * 0.09 || Math.abs(c) > Math.abs(d) * 0.09;
      items.push({
        str: raw.str,
        x: raw.transform[4],
        y: raw.transform[5],
        width: raw.width ?? 0,
        height: raw.height || Math.abs(raw.transform[3]) || 10,
        page: p,
        rotated,
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
