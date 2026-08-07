import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

/**
 * Le commit d'où sort *cette* compilation, gravé dans le bundle.
 *
 * Comparé au commit réellement présent dans le dossier, il répond à une
 * question qu'aucun autre indice ne tranche : l'interface affichée à l'écran
 * est-elle bien celle du code installé ? Une fenêtre restée ouverte pendant une
 * mise à jour, un `dist/` qui n'a pas été régénéré, deux copies du dépôt sur la
 * même machine — tout cela produit un écran périmé que rien ne distingue d'un
 * écran à jour, et fait chercher pendant des heures une nouveauté qui ne peut
 * pas apparaître.
 */
function buildCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Pas de git (archive téléchargée, image de conteneur) : la comparaison est
    // simplement désactivée, jamais bloquante.
    return '';
  }
}

export default defineConfig({
  root: '.',
  base: './',
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5199,
    strictPort: true,
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
