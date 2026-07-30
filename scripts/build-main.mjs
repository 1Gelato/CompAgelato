import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const watch = process.argv.includes('--watch');

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

/** Dependencies kept outside the bundle (loaded from node_modules / asar at runtime). */
const external = ['electron', 'pdfjs-dist', 'chokidar', 'xlsx', 'qrcode', 'fast-xml-parser'];

const mainConfig = {
  entryPoints: [path.join(root, 'electron/main.ts')],
  outfile: path.join(root, 'dist/main/main.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external,
  plugins: [alias],
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
};

const preloadConfig = {
  entryPoints: [path.join(root, 'electron/preload.ts')],
  outfile: path.join(root, 'dist/main/preload.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  plugins: [alias],
  logLevel: 'info',
};

if (watch) {
  const ctxs = await Promise.all([esbuild.context(mainConfig), esbuild.context(preloadConfig)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[build-main] watching…');
} else {
  await Promise.all([esbuild.build(mainConfig), esbuild.build(preloadConfig)]);
}
