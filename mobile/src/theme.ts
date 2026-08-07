/**
 * La même langue visuelle que le bureau : accent bleu, fonds doux, angles
 * arrondis. Un seul thème clair en v1 — la sobriété avant tout.
 */
export const colors = {
  bg: '#f5f5f7',
  card: '#ffffff',
  text: '#1d1d1f',
  secondary: '#6e6e73',
  tertiary: '#98989d',
  separator: 'rgba(0, 0, 0, 0.09)',
  accent: '#0071e3',
  accentSoft: 'rgba(0, 113, 227, 0.1)',
  green: '#1d8f4e',
  greenSoft: 'rgba(29, 143, 78, 0.12)',
  orange: '#b25000',
  orangeSoft: 'rgba(178, 80, 0, 0.12)',
  red: '#d02b20',
  redSoft: 'rgba(208, 43, 32, 0.12)',
  purple: '#6a4bbc',
  purpleSoft: 'rgba(106, 75, 188, 0.12)',
} as const;

export const radius = { sm: 8, md: 12, lg: 16 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export type Tone = 'default' | 'info' | 'success' | 'warn' | 'danger';

export const toneColors: Record<Tone, { fg: string; bg: string }> = {
  default: { fg: colors.secondary, bg: 'rgba(0,0,0,0.05)' },
  info: { fg: colors.accent, bg: colors.accentSoft },
  success: { fg: colors.green, bg: colors.greenSoft },
  warn: { fg: colors.orange, bg: colors.orangeSoft },
  danger: { fg: colors.red, bg: colors.redSoft },
};
