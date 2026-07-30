import { BrowserWindow, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PrintResult {
  /** Vrai seulement si le document est réellement parti à l'impression. */
  printed: boolean;
  /** `dialog` = boîte d'impression du système, `viewer` = ouverture dans la visionneuse. */
  method: 'dialog' | 'viewer';
  message: string;
}

const PRINTABLE = new Set(['.pdf']);

/**
 * Envoie un document à l'impression.
 *
 * Un PDF est chargé dans une fenêtre invisible puis passé à la boîte
 * d'impression du système. Pour les autres formats — ou si l'impression
 * directe échoue — le fichier est simplement ouvert dans l'application par
 * défaut, à charge pour l'utilisateur de lancer l'impression.
 */
export async function printFile(filePath: string): Promise<PrintResult> {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Le fichier d'origine est introuvable sur le disque.");
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!PRINTABLE.has(ext)) {
    await shell.openPath(filePath);
    return {
      printed: false,
      method: 'viewer',
      message: `Les fichiers ${ext || 'de ce type'} ne s'impriment pas directement : le document a été ouvert, lancez l'impression depuis l'application.`,
    };
  }

  let printWindow: BrowserWindow | null = null;
  try {
    printWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        // Fenêtre technique : aucun script de l'application n'y est chargé.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        plugins: true,
      },
    });

    await printWindow.loadURL(pathToFileURL(filePath).toString());
    // La visionneuse PDF a besoin d'un instant pour composer la première page.
    await new Promise((resolve) => setTimeout(resolve, 600));

    const outcome = await new Promise<{ success: boolean; reason: string }>((resolve) => {
      // Sécurité : si la boîte d'impression ne rend jamais la main, on n'attend
      // pas indéfiniment et la fenêtre technique est refermée.
      const timer = setTimeout(() => resolve({ success: false, reason: 'timeout' }), 180000);
      printWindow!.webContents.print(
        { silent: false, printBackground: true, color: true },
        (success, reason) => {
          clearTimeout(timer);
          resolve({ success, reason });
        },
      );
    });

    if (outcome.success) {
      return { printed: true, method: 'dialog', message: 'Document envoyé à l’imprimante.' };
    }
    if (/cancel/i.test(outcome.reason)) {
      return { printed: false, method: 'dialog', message: 'Impression annulée.' };
    }
    throw new Error(outcome.reason || 'impression refusée');
  } catch (err) {
    // Repli : ouverture dans la visionneuse par défaut.
    await shell.openPath(filePath);
    return {
      printed: false,
      method: 'viewer',
      message: `Impression directe indisponible (${(err as Error).message}). Le document a été ouvert : lancez l'impression depuis la visionneuse.`,
    };
  } finally {
    if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
  }
}
