import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const info = server.config.server;
const url = `http://localhost:${info.port}`;
server.printUrls();

// Bundle main + preload in watch mode.
const builder = spawn(process.execPath, [path.join(root, 'scripts/build-main.mjs'), '--watch'], {
  stdio: 'inherit',
  cwd: root,
});

// Give esbuild a moment for the first emit.
await new Promise((r) => setTimeout(r, 1500));

let child = null;
const startElectron = () => {
  child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, NODE_ENV: 'development', VITE_DEV_SERVER_URL: url },
  });
  child.on('close', () => {
    builder.kill();
    server.close().then(() => process.exit(0));
  });
};

startElectron();

process.on('SIGINT', () => {
  child?.kill();
  builder.kill();
  process.exit(0);
});
