import fs from 'node:fs';
import path from 'node:path';
import type { Attachment, ID } from '@shared/types';
import { newId, nowIso, store } from '../store';

/**
 * Bibliothèque de pièces jointes réutilisables (flyers, plaquettes,
 * conditions générales…). Les fichiers sont recopiés dans un sous-dossier du
 * dossier de travail : l'envoi reste possible même si l'original est déplacé.
 */

export const ATTACHMENTS_FOLDER = 'Pieces-jointes';

export function attachmentsFolder(): string {
  const folder = path.join(store.settings.watchFolder, ATTACHMENTS_FOLDER);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function uniqueTarget(folder: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(folder, fileName);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(folder, `${base} (${counter})${ext}`);
    counter++;
  }
  return candidate;
}

export function listAttachments(): Attachment[] {
  return store.db.attachments
    .filter((a) => !a.archived)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Ajoute un fichier à la bibliothèque en le recopiant dans le dossier dédié. */
export function addAttachment(sourcePath: string, options: { name?: string; category?: string } = {}): Attachment {
  if (!fs.existsSync(sourcePath)) throw new Error('Fichier introuvable.');
  const folder = attachmentsFolder();
  const fileName = path.basename(sourcePath);

  // Un fichier déjà présent dans le dossier n'est pas recopié.
  const alreadyInside = path.dirname(path.resolve(sourcePath)) === path.resolve(folder);
  const target = alreadyInside ? sourcePath : uniqueTarget(folder, fileName);
  if (!alreadyInside) fs.copyFileSync(sourcePath, target);

  const existing = store.db.attachments.find((a) => path.resolve(a.filePath) === path.resolve(target));
  if (existing) {
    return store.mutate(() => {
      existing.archived = false;
      existing.size = fs.statSync(target).size;
      if (options.name) existing.name = options.name;
      if (options.category) existing.category = options.category;
      return existing;
    });
  }

  return store.mutate((db) => {
    const attachment: Attachment = {
      id: newId('att'),
      name: options.name?.trim() || path.basename(target, path.extname(target)),
      filePath: target,
      size: fs.statSync(target).size,
      category: options.category,
      defaultSelected: false,
      archived: false,
      createdAt: nowIso(),
    };
    db.attachments.push(attachment);
    return attachment;
  });
}

export function updateAttachment(id: ID, patch: Partial<Attachment>): Attachment {
  return store.mutate((db) => {
    const attachment = db.attachments.find((a) => a.id === id);
    if (!attachment) throw new Error('Pièce jointe introuvable.');
    Object.assign(attachment, {
      name: patch.name ?? attachment.name,
      category: patch.category ?? attachment.category,
      defaultSelected: patch.defaultSelected ?? attachment.defaultSelected,
      archived: patch.archived ?? attachment.archived,
    });
    return attachment;
  });
}

/** Retire la pièce jointe de la bibliothèque ; le fichier reste sur le disque. */
export function removeAttachment(id: ID): void {
  store.mutate((db) => {
    db.attachments = db.attachments.filter((a) => a.id !== id);
  });
}

/**
 * Reprend les fichiers déposés directement dans le dossier « Pieces-jointes »
 * sans passer par le bouton d'ajout.
 */
export function syncAttachmentsFolder(): { added: number; missing: number } {
  const folder = attachmentsFolder();
  let added = 0;
  let missing = 0;

  let files: string[] = [];
  try {
    files = fs.readdirSync(folder).filter((f) => !f.startsWith('.') && !f.startsWith('~$'));
  } catch {
    return { added: 0, missing: 0 };
  }

  const known = new Set(store.db.attachments.map((a) => path.resolve(a.filePath)));
  for (const file of files) {
    const full = path.join(folder, file);
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    if (known.has(path.resolve(full))) continue;
    addAttachment(full);
    added++;
  }

  // Une pièce dont le fichier a disparu est signalée plutôt que supprimée.
  store.mutate((db) => {
    for (const attachment of db.attachments) {
      if (!fs.existsSync(attachment.filePath)) missing++;
    }
  });

  return { added, missing };
}

export function attachmentExists(attachment: Attachment): boolean {
  return fs.existsSync(attachment.filePath);
}
