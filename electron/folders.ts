import fs from 'node:fs';
import path from 'node:path';
import type { DocumentKind } from '@shared/types';

/**
 * Les dossiers que ce poste surveille pour les envoyer au serveur.
 *
 * Le logiciel de comptabilité écrit ses PDF dans des dossiers du poste ; le
 * serveur, lui, ne voit que le sien. Sans ce pont, il faut à chaque fois ouvrir
 * l'application et désigner les fichiers à la main — le geste répétitif que
 * cette liste supprime.
 *
 * Comme la liaison au serveur, ce réglage **appartient à l'appareil et non à
 * l'entreprise** : `D:\Compta\Factures` n'a aucun sens sur le téléphone du
 * livreur, et se synchroniser enverrait chaque poste surveiller les dossiers de
 * son voisin. Il vit donc dans un fichier local, à côté de `connexion.json`.
 */

/** Type d'un dossier surveillé. `statement` part vers le lecteur de relevés. */
export type FolderKind = DocumentKind | 'statement';

export interface UploadFolder {
  id: string;
  path: string;
  kind: FolderKind;
}

/**
 * Ce qui a déjà été envoyé, pour ne pas renvoyer indéfiniment le même fichier.
 *
 * Taille et date de modification suffisent : le serveur compare de toute façon
 * les contenus avant de ranger quoi que ce soit, si bien qu'un envoi en trop ne
 * crée jamais de doublon. Ce registre n'est donc pas une garantie d'exactitude,
 * seulement une économie — et il ne doit surtout pas empêcher un renvoi en cas
 * de doute.
 */
interface SentMark {
  size: number;
  mtimeMs: number;
}

interface FoldersFile {
  folders: UploadFolder[];
  sent: Record<string, SentMark>;
}

const EMPTY: FoldersFile = { folders: [], sent: {} };

let file = '';
let state: FoldersFile = { ...EMPTY };

function persist(): void {
  if (!file) return;
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function initFolders(dataDir: string): UploadFolder[] {
  file = path.join(dataDir, 'dossiers.json');
  state = { ...EMPTY };
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<FoldersFile>;
      state = {
        folders: Array.isArray(parsed.folders) ? parsed.folders : [],
        sent: parsed.sent && typeof parsed.sent === 'object' ? parsed.sent : {},
      };
    }
  } catch (err) {
    // Fichier illisible : on repart d'une liste vide plutôt que d'empêcher
    // l'application de démarrer. Au pire, quelques fichiers seront renvoyés.
    console.error('[dossiers] fichier illisible, liste vide :', err);
    state = { ...EMPTY };
  }
  return listFolders();
}

export function listFolders(): UploadFolder[] {
  return state.folders.map((f) => ({ ...f }));
}

/** Ajoute ou remplace un dossier. Le même chemin ne peut pas être surveillé deux fois. */
export function saveFolder(input: { id?: string; path: string; kind: FolderKind }): UploadFolder {
  const target = path.resolve(input.path);
  if (!target) throw new Error('Chemin vide.');
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`Ce dossier n'existe pas sur ce poste : ${target}`);
  }

  const duplicate = state.folders.find(
    (f) => f.id !== input.id && path.resolve(f.path).toLowerCase() === target.toLowerCase(),
  );
  if (duplicate) {
    throw new Error('Ce dossier est déjà surveillé : un fichier n’a pas à partir deux fois.');
  }

  const existing = input.id ? state.folders.find((f) => f.id === input.id) : undefined;
  if (existing) {
    existing.path = target;
    existing.kind = input.kind;
    persist();
    return { ...existing };
  }

  const created: UploadFolder = {
    id: `dos_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    path: target,
    kind: input.kind,
  };
  state.folders.push(created);
  persist();
  return { ...created };
}

export function removeFolder(id: string): UploadFolder[] {
  state.folders = state.folders.filter((f) => f.id !== id);
  persist();
  return listFolders();
}

/* ------------------------------------------------------------------ */
/* Registre des envois                                                  */
/* ------------------------------------------------------------------ */

function markKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

/** Ce fichier a-t-il déjà été envoyé dans cet état ? */
export function alreadySent(filePath: string, size: number, mtimeMs: number): boolean {
  const mark = state.sent[markKey(filePath)];
  if (!mark) return false;
  // Une modification, même à taille égale, doit repartir : une facture corrigée
  // porte le même nom et le même poids qu'avant.
  return mark.size === size && Math.abs(mark.mtimeMs - mtimeMs) < 1000;
}

export function markSent(filePath: string, size: number, mtimeMs: number): void {
  state.sent[markKey(filePath)] = { size, mtimeMs };
  persist();
}

/**
 * Oublie les fichiers d'un dossier qui n'est plus surveillé, et ceux qui ont
 * disparu du disque : sans cela le registre grossirait indéfiniment, et un
 * fichier remis en place ne repartirait jamais.
 */
export function forgetVanished(): number {
  let removed = 0;
  for (const key of Object.keys(state.sent)) {
    const watched = state.folders.some((f) => key.startsWith(path.resolve(f.path).toLowerCase()));
    if (!watched || !fs.existsSync(key)) {
      delete state.sent[key];
      removed++;
    }
  }
  if (removed) persist();
  return removed;
}

/** Remet tout à zéro pour un dossier : le prochain passage renverra tout. */
export function forgetFolder(folderPath: string): void {
  const prefix = path.resolve(folderPath).toLowerCase();
  for (const key of Object.keys(state.sent)) {
    if (key.startsWith(prefix)) delete state.sent[key];
  }
  persist();
}
