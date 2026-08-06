/**
 * Bundle les services « purs » (sans dépendance à Electron) dans un module ESM
 * unique, consommé par les tests `node --test`.
 */
import esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const alias = {
  name: 'alias-shared',
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => {
      const base = path.join(root, 'shared', args.path.replace(/^@shared\//, ''));
      // esbuild ne complète pas l'extension pour un chemin renvoyé tel quel.
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate };
      }
      return { errors: [{ text: `Module introuvable : ${args.path}` }] };
    });
  },
};

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  external: ['pdfjs-dist', 'chokidar', 'xlsx', 'qrcode', 'fast-xml-parser', 'electron', 'react'],
  plugins: [alias],
  logLevel: 'warning',
};

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'tests/entry.ts')],
  outfile: path.join(root, 'tests/build/services.mjs'),
});

// Logique d'interface testable sans navigateur : tri des tableaux et
// recherche par montant sont des fonctions pures, on les vérifie comme le reste.
await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'tests/ui-entry.ts')],
  outfile: path.join(root, 'tests/build/ui.mjs'),
});
