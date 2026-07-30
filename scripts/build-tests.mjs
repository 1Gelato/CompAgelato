/**
 * Bundle les services « purs » (sans dépendance à Electron) dans un module ESM
 * unique, consommé par les tests `node --test`.
 */
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const alias = {
  name: 'alias-shared',
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(root, 'shared', args.path.replace(/^@shared\//, '')),
    }));
  },
};

await esbuild.build({
  entryPoints: [path.join(root, 'tests/entry.ts')],
  outfile: path.join(root, 'tests/build/services.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  external: ['pdfjs-dist', 'chokidar', 'xlsx', 'qrcode', 'fast-xml-parser', 'electron'],
  plugins: [alias],
  logLevel: 'warning',
});
