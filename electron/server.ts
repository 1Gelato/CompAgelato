import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNELS } from '@shared/api';
import { coreHandlers, emlFilePath, setBroadcast } from './handlers';
import { store, newId } from './store';
import { resolvePath } from './services/paths';

/**
 * Serveur CompaGelato : le même registre de gestionnaires que l'application de
 * bureau, servi en HTTP. Aucune dépendance — uniquement `node:http` — pour que
 * l'installation sur le boîtier du dépôt reste `npm ci` et rien d'autre.
 *
 * Routes :
 *   POST /api/<domaine>/<méthode>   appel d'un gestionnaire, arguments en corps
 *   GET  /api/events                flux SSE (documents-changed, scan-progress, toast)
 *   GET  /files/document/<id>       le PDF d'origine d'une pièce
 *   GET  /files/attachment/<id>     une pièce jointe de la bibliothèque
 *   GET  /files/eml/<jeton>         un brouillon d'e-mail préparé côté serveur
 *   POST /upload/<type>             téléversement (clients, products, bank, attachments, restore)
 *   GET  /…                         l'interface web (dist/renderer)
 */

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Jeton exigé sur /api, /files et /upload quand il est renseigné. */
  token?: string;
  /** Dossier de l'interface compilée ; déduit du bundle par défaut. */
  rendererDir?: string;
}

interface SseClient {
  id: number;
  res: http.ServerResponse;
}

const JSON_LIMIT = 10 * 1024 * 1024;
const UPLOAD_LIMIT = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.eml': 'message/rfc822',
  '.csv': 'text/csv; charset=utf-8',
  '.woff2': 'font/woff2',
};

function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Fichier trop volumineux.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function streamFile(
  res: http.ServerResponse,
  file: string,
  options: { downloadName?: string } = {},
): void {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendJson(res, 404, { ok: false, error: 'Le fichier n’est plus à son emplacement.' });
    return;
  }
  const name = options.downloadName ?? path.basename(file);
  res.writeHead(200, {
    'Content-Type': contentType(file),
    'Content-Length': fs.statSync(file).size,
    // `inline` : le navigateur affiche le PDF ; les .eml sont proposés en
    // téléchargement pour être ouverts dans la messagerie.
    'Content-Disposition': `${options.downloadName ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

/** Adresses IPv4 de la machine, pour afficher où se connecter. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  broadcast: (channel: string, payload: unknown) => void;
  close(): Promise<void>;
}

export function createCompaServer(options: ServerOptions = {}): Promise<RunningServer> {
  const token = options.token?.trim() || '';
  const rendererDir =
    options.rendererDir ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer');

  /* ---------------- SSE ---------------- */
  const sseClients = new Set<SseClient>();
  let sseId = 0;

  const broadcast = (channel: string, payload: unknown): void => {
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const client of sseClients) {
      try {
        client.res.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  };
  setBroadcast(broadcast);

  // Battement de cœur : certains proxys coupent les connexions muettes.
  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, 25_000);
  heartbeat.unref();

  /* ---------------- Téléversements ---------------- */

  const uploadDir = path.join(os.tmpdir(), 'compagelato-uploads');

  async function handleUpload(kind: string, fileName: string, body: Buffer): Promise<unknown> {
    fs.mkdirSync(uploadDir, { recursive: true });
    const safe = path.basename(fileName || 'fichier').replace(/[\\/:*?"<>|]/g, '_');
    const file = path.join(uploadDir, `${newId('up')}-${safe}`);
    fs.writeFileSync(file, body);
    try {
      switch (kind) {
        case 'clients':
          return await coreHandlers.clients.importFrom(file);
        case 'products':
          return await coreHandlers.products.importFrom(file);
        case 'bank':
          return await coreHandlers.bank.importFrom(file);
        case 'attachments':
          return await coreHandlers.attachments.addFiles([file]);
        case 'restore':
          return await coreHandlers.db.restore(file);
        default:
          throw new Error(`Type de téléversement inconnu : ${kind}`);
      }
    } finally {
      // La pièce jointe est copiée dans sa bibliothèque, l'import est en base :
      // le fichier temporaire ne sert plus.
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------------- Autorisation ---------------- */

  function authorized(req: http.IncomingMessage, url: URL): boolean {
    if (!token) return true;
    const header = req.headers.authorization;
    if (header === `Bearer ${token}`) return true;
    if (req.headers['x-auth-token'] === token) return true;
    // EventSource et les liens de téléchargement ne peuvent pas poser d'en-tête.
    if (url.searchParams.get('token') === token) return true;
    return false;
  }

  /* ---------------- Statique ---------------- */

  function serveStatic(res: http.ServerResponse, pathname: string): void {
    const target = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(rendererDir, target));
    if (!file.startsWith(path.normalize(rendererDir + path.sep))) {
      sendJson(res, 403, { ok: false, error: 'Chemin refusé.' });
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': contentType(file) });
      fs.createReadStream(file).pipe(res);
      return;
    }
    // Application monopage : toute autre adresse renvoie l'index.
    const index = path.join(rendererDir, 'index.html');
    if (fs.existsSync(index)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      fs.createReadStream(index).pipe(res);
    } else {
      sendJson(res, 404, {
        ok: false,
        error: "Interface introuvable : lancez « npm run build » avant de démarrer le serveur.",
      });
    }
  }

  /* ---------------- Routage ---------------- */

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);

    try {
      const isProtected =
        segments[0] === 'api' || segments[0] === 'files' || segments[0] === 'upload';
      if (isProtected && !authorized(req, url)) {
        sendJson(res, 401, { ok: false, error: 'Jeton d’accès manquant ou invalide.' });
        return;
      }

      // --- Flux d'événements ---
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(': bienvenue\n\n');
        const client: SseClient = { id: ++sseId, res };
        sseClients.add(client);
        req.on('close', () => sseClients.delete(client));
        return;
      }

      // --- Appels de gestionnaires ---
      if (req.method === 'POST' && segments[0] === 'api' && segments.length === 3) {
        const [, namespace, method] = segments;
        const channels = (CHANNELS as Record<string, readonly string[]>)[namespace];
        const handler = coreHandlers[namespace]?.[method];
        if (!channels?.includes(method) || !handler) {
          sendJson(res, 404, { ok: false, error: `Canal inconnu : ${namespace}:${method}` });
          return;
        }
        const raw = await readBody(req, JSON_LIMIT);
        const args: unknown[] = raw.length ? (JSON.parse(raw.toString('utf8')).args ?? []) : [];
        try {
          const result = await handler(...args);
          sendJson(res, 200, { ok: true, result: result ?? null });
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          console.error(`[serveur] ${namespace}:${method} :`, message);
          sendJson(res, 400, { ok: false, error: message });
        }
        return;
      }

      // --- Fichiers ---
      if (req.method === 'GET' && segments[0] === 'files' && segments.length === 3) {
        const [, kind, id] = segments;
        if (kind === 'document') {
          const doc = store.db.documents.find((d) => d.id === id);
          if (!doc?.sourceFile) {
            sendJson(res, 404, { ok: false, error: "Ce document n'a pas de fichier d'origine." });
            return;
          }
          streamFile(res, resolvePath(doc.sourceFile));
          return;
        }
        if (kind === 'attachment') {
          const attachment = store.db.attachments.find((a) => a.id === id);
          if (!attachment) {
            sendJson(res, 404, { ok: false, error: 'Pièce jointe introuvable.' });
            return;
          }
          streamFile(res, resolvePath(attachment.filePath));
          return;
        }
        if (kind === 'eml') {
          const file = emlFilePath(id);
          if (!file) {
            sendJson(res, 404, { ok: false, error: 'Brouillon expiré : préparez-le à nouveau.' });
            return;
          }
          streamFile(res, file, { downloadName: path.basename(file) });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'Type de fichier inconnu.' });
        return;
      }

      // --- Téléversements ---
      if (req.method === 'POST' && segments[0] === 'upload' && segments.length === 2) {
        const kind = segments[1];
        const fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
        const body = await readBody(req, UPLOAD_LIMIT);
        if (!body.length) {
          sendJson(res, 400, { ok: false, error: 'Fichier vide.' });
          return;
        }
        try {
          const result = await handleUpload(kind, fileName, body);
          sendJson(res, 200, { ok: true, result: result ?? null });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: (err as Error).message ?? String(err) });
        }
        return;
      }

      // --- Interface web ---
      if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(res, url.pathname);
        return;
      }

      sendJson(res, 405, { ok: false, error: 'Méthode non autorisée.' });
    } catch (err) {
      console.error('[serveur]', err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: (err as Error).message ?? 'Erreur interne.' });
      } else {
        res.end();
      }
    }
  });

  const port = options.port ?? 4680;
  const host = options.host ?? '0.0.0.0';

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        port: boundPort,
        broadcast,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const client of sseClients) client.res.end();
            sseClients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
