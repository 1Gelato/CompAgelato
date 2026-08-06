import path from 'node:path';
import { store } from '../store';

/**
 * Chemins de fichiers stockés en base.
 *
 * Un fichier situé dans le dossier de travail est enregistré **relativement** à
 * ce dossier (« Factures/FA-2026-0142.pdf ») plutôt qu'en absolu. Sans cela,
 * déplacer le dossier — ou l'ouvrir depuis une autre machine — casserait tout :
 * la déduplication des documents compare ces chemins caractère par caractère,
 * et chaque pièce serait réimportée en double.
 *
 * Les fichiers extérieurs au dossier de travail (un relevé bancaire rangé
 * ailleurs, par exemple) restent enregistrés en absolu : les rendre relatifs
 * n'aurait aucun sens.
 *
 * Le séparateur enregistré est toujours « / », y compris sous Windows, pour que
 * la base reste lisible d'un système à l'autre.
 */

/** Convertit un chemin absolu en la forme à enregistrer en base. */
export function storePath(absolute: string, root = store.settings.watchFolder): string {
  if (!absolute) return absolute;
  if (!root) return absolute;
  const relative = path.relative(path.resolve(root), path.resolve(absolute));
  // `path.relative` remonte avec « .. » quand le fichier est en dehors.
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return absolute;
  return relative.split(path.sep).join('/');
}

/** Reconstitue le chemin réel d'un fichier enregistré en base. */
export function resolvePath(stored: string, root = store.settings.watchFolder): string {
  if (!stored) return stored;
  if (path.isAbsolute(stored)) return stored;
  return path.resolve(root, stored);
}
