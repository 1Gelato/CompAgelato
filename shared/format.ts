const currencyFormatter = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactCurrency = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

export function euro(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return currencyFormatter.format(value);
}

export function euroShort(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1000 ? compactCurrency.format(value) : currencyFormatter.format(value);
}

export function num(value: number | null | undefined, unit?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return unit ? `${numberFormatter.format(value)} ${unit}` : numberFormatter.format(value);
}

export function dateFr(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

export function dateLong(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function dateTimeFr(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Durée en minutes → « 2 h 35 » ou « 45 min ». */
export function duration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

export function km(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${numberFormatter.format(Math.round(value * 10) / 10)} km`;
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)} %`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

export const KIND_LABEL: Record<string, string> = {
  invoice: 'Facture',
  quote: 'Devis',
  credit: 'Avoir',
};

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Brouillon',
  confirmed: 'Validé',
  paid: 'Réglé',
  cancelled: 'Annulé',
};

export const STATUS_TONE: Record<string, string> = {
  draft: '',
  confirmed: 'badge--blue',
  paid: 'badge--green',
  cancelled: 'badge--red',
};

export const BANK_CATEGORY_LABEL: Record<string, string> = {
  sales: 'Ventes',
  suppliers: 'Fournisseurs',
  payroll: 'Salaires',
  taxes: 'Charges et impôts',
  fuel: 'Carburant et péages',
  bankFees: 'Frais bancaires',
  rent: 'Loyer',
  insurance: 'Assurances',
  utilities: 'Énergie et télécom',
  transfer: 'Virements internes',
  other: 'À classer',
};

export const BANK_CATEGORY_TONE: Record<string, string> = {
  sales: 'badge--green',
  suppliers: 'badge--blue',
  payroll: 'badge--purple',
  taxes: 'badge--red',
  fuel: 'badge--orange',
  bankFees: 'badge--red',
  rent: 'badge--purple',
  insurance: 'badge--blue',
  utilities: 'badge--blue',
  transfer: '',
  other: '',
};

/** Mois « 2026-01 » → « janvier 2026 ». */
export function monthLong(month: string): string {
  const date = new Date(`${month}-01T12:00:00`);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}

export const REGISTER_KIND_LABEL: Record<string, string> = {
  sav: 'SAV',
  consumables: 'Consommables',
  event: 'Événementiel',
};

/** Libellés de statut propres à chaque cahier. */
export const REGISTER_STATUS_LABEL: Record<string, Record<string, string>> = {
  sav: { open: 'À traiter', confirmed: 'En cours', done: 'Résolu', cancelled: 'Annulé' },
  consumables: { open: 'À préparer', confirmed: 'En préparation', done: 'Livré', cancelled: 'Annulé' },
  event: { open: 'Demande', confirmed: 'Devis validé', done: 'Terminé', cancelled: 'Annulé' },
};

export const REGISTER_STATUS_TONE: Record<string, string> = {
  open: 'badge--orange',
  confirmed: 'badge--blue',
  done: 'badge--green',
  cancelled: 'badge--red',
};

export const FUEL_LABEL: Record<string, string> = {
  gazole: 'Gazole',
  sp95: 'SP95 / E10',
  sp98: 'SP98',
  e85: 'E85 (superéthanol)',
  gplc: 'GPL',
  electrique: 'Électrique',
};

/** Recherche insensible aux accents et à la casse. */
export function matches(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const clean = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return clean(haystack).includes(clean(needle));
}
