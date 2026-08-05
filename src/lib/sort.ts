import { useCallback, useMemo, useState } from 'react';

/**
 * Tri des tableaux : un clic sur un en-tête trie, un second inverse le sens.
 *
 * Chaque colonne triable fournit une fonction qui extrait la valeur à comparer.
 * Le tri est stable et gère les valeurs manquantes, toujours rejetées en fin de
 * liste quel que soit le sens — une ligne sans montant n'a rien à faire en tête
 * du classement des plus gros montants.
 */

export type SortDirection = 'asc' | 'desc';
export type SortValue = string | number | boolean | null | undefined;
export type SortAccessors<T> = Record<string, (row: T) => SortValue>;

export interface SortState {
  key: string;
  direction: SortDirection;
}

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

/** Compare deux valeurs ; les vides sont toujours renvoyées en fin de liste. */
export function compareValues(a: SortValue, b: SortValue, direction: SortDirection): number {
  const emptyA = a === null || a === undefined || a === '';
  const emptyB = b === null || b === undefined || b === '';
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;

  let result: number;
  if (typeof a === 'number' && typeof b === 'number') result = a - b;
  else if (typeof a === 'boolean' && typeof b === 'boolean') result = Number(a) - Number(b);
  else result = collator.compare(String(a), String(b));

  return direction === 'asc' ? result : -result;
}

export function sortRows<T>(
  rows: T[],
  state: SortState | null,
  accessors: SortAccessors<T>,
): T[] {
  if (!state) return rows;
  const accessor = accessors[state.key];
  if (!accessor) return rows;
  // `map` puis `sort` sur les index garde un tri stable même sur les moteurs
  // qui ne le garantiraient pas, et n'évalue l'accesseur qu'une fois par ligne.
  return rows
    .map((row, index) => ({ row, index, value: accessor(row) }))
    .sort((a, b) => compareValues(a.value, b.value, state.direction) || a.index - b.index)
    .map((entry) => entry.row);
}

export function useSort<T>(
  rows: T[],
  accessors: SortAccessors<T>,
  initial: SortState | null = null,
): {
  sorted: T[];
  sort: SortState | null;
  /** Trie sur cette colonne ; un second appel inverse le sens. */
  toggle: (key: string) => void;
} {
  const [sort, setSort] = useState<SortState | null>(initial);

  const toggle = useCallback((key: string) => {
    setSort((current) => {
      if (current?.key !== key) {
        // Les colonnes de date et de montant s'ouvrent du plus grand au plus
        // petit : c'est ce qu'on cherche en les triant (les plus récentes, les
        // plus élevées).
        return { key, direction: DESC_FIRST.test(key) ? 'desc' : 'asc' };
      }
      return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
    });
  }, []);

  const sorted = useMemo(() => sortRows(rows, sort, accessors), [rows, sort, accessors]);

  return { sorted, sort, toggle };
}

/** Colonnes dont le premier clic doit trier du plus grand au plus petit. */
const DESC_FIRST = /(date|total|montant|amount|solde|balance|value|valeur|qty|qte|count|nombre|pieces|debit|credit)/i;
