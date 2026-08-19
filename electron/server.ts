import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNELS, CHANNEL_ACCESS, mayCall } from '@shared/api';
import type { AuthIdentity, ChannelName } from '@shared/api';
import type { DocumentKind, Role } from '@shared/types';
import { coreHandlers, emlFilePath, setBroadcast } from './handlers';
import { store, newId } from './store';
import { resolvePath } from './services/paths';
import { withContext } from './context';
import { accountsConfigured, identityOf, resolveSession } from './services/auth';

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
 *   GET  /files/backup             la base entière, pour la copie de sécurité d'un poste
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

/**
 * D'où vient l'appel. Sert à limiter les tentatives de connexion par appareil
 * plutôt que globalement : sans cela, un seul poste qui se trompe verrouillerait
 * le compte pour toute l'entreprise.
 */
function clientAddress(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? 'inconnu';
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

/**
 * Tout canal déclaré est-il classé dans la table des droits ?
 *
 * Le type `Record<ChannelName, …>` l'impose déjà à la compilation. Ce contrôle
 * au démarrage double la garantie côté exécution : un bundle produit sans
 * `npm run typecheck` ne doit pas pouvoir servir un canal non classé.
 */
function assertAccessTableComplete(): void {
  const missing: string[] = [];
  for (const [namespace, methods] of Object.entries(CHANNELS)) {
    for (const method of methods as readonly string[]) {
      const channel = `${namespace}:${method}` as ChannelName;
      if (!CHANNEL_ACCESS[channel]) missing.push(channel);
    }
  }
  if (missing.length) {
    throw new Error(
      `Canaux sans droits déclarés : ${missing.join(', ')}. Complétez CHANNEL_ACCESS dans shared/api.ts.`,
    );
  }
}

export function createCompaServer(options: ServerOptions = {}): Promise<RunningServer> {
  assertAccessTableComplete();
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

  async function handleUpload(
    kind: string,
    fileName: string,
    body: Buffer,
    // Type déjà connu de l'appelant : un poste qui surveille son propre dossier
    // « Factures » sait ce qu'il envoie. La pièce est alors rangée dans le
    // sous-dossier correspondant, au lieu d'être redevinée puis posée en vrac.
    documentKind?: DocumentKind,
  ): Promise<unknown> {
    // Chaque téléversement a son propre dossier, ce qui laisse au fichier son
    // nom d'origine : c'est celui-là qui sera rangé dans le dossier surveillé
    // ou dans la bibliothèque de pièces jointes.
    const safe = path.basename(fileName || 'fichier').replace(/[\\/:*?"<>|]/g, '_');
    const folder = path.join(uploadDir, newId('up'));
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, safe);
    fs.writeFileSync(file, body);
    try {
      switch (kind) {
        case 'clients':
          return await coreHandlers.clients.importFrom(file);
        case 'products':
          return await coreHandlers.products.importFrom(file);
        case 'bank':
          return await coreHandlers.bank.importFrom(file);
        case 'documents':
          return await coreHandlers.documents.addFiles([file], documentKind);
        case 'attachments':
          return await coreHandlers.attachments.addFiles([file]);
        case 'restore':
          return await coreHandlers.db.restore(file);
        default:
          throw new Error(`Type de téléversement inconnu : ${kind}`);
      }
    } finally {
      // La pièce est rangée à sa place définitive et l'import est en base :
      // le dossier temporaire ne sert plus.
      try {
        fs.rmSync(folder, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------------- Qui appelle, et a-t-il le droit ? ---------------- */

  /**
   * Le contrôle des droits vit **ici et nulle part ailleurs**. Aucun service
   * métier ne vérifie quoi que ce soit : tout appel distant passe par cet
   * aiguillage, y compris le téléchargement des fichiers. Sans cela, deviner un
   * identifiant de document suffirait à récupérer n'importe quelle facture.
   */
  interface Caller {
    identity: AuthIdentity | null;
    /** `null` : appelant non authentifié. */
    role: Role | null;
    token: string;
  }

  function credentialFrom(req: http.IncomingMessage, url: URL): string {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
    const custom = req.headers['x-auth-token'];
    if (typeof custom === 'string' && custom) return custom;
    // EventSource et les liens de téléchargement ne peuvent pas poser d'en-tête.
    return url.searchParams.get('token') ?? '';
  }

  function resolveCaller(req: http.IncomingMessage, url: URL): Caller {
    const presented = credentialFrom(req, url);

    const session = resolveSession(presented);
    if (session) {
      return { identity: identityOf(session.user), role: session.user.role, token: presented };
    }

    // Des comptes existent : seule une session ouverte donne accès. Le jeton
    // partagé ne suffit plus — sinon le rôle de chacun ne voudrait rien dire.
    if (accountsConfigured()) return { identity: null, role: null, token: presented };

    // Aucun compte : fonctionnement d'origine, jeton partagé et pleins droits.
    // C'est ce qui permet de créer le premier compte, et ce qui garantit qu'un
    // serveur déjà installé continue de marcher après mise à jour.
    if (!token || presented === token) {
      return { identity: null, role: 'gerant', token: presented };
    }
    return { identity: null, role: null, token: presented };
  }

  /** Canaux joignables sans session : ceux qui servent justement à en ouvrir une. */
  const PUBLIC_CHANNELS = new Set<ChannelName>(['auth:status', 'auth:login']);

  function refuse(res: http.ServerResponse, caller: Caller, what: string): void {
    if (!caller.role) {
      sendJson(res, 401, { ok: false, error: 'Connexion requise.', authRequired: true });
      return;
    }
    sendJson(res, 403, {
      ok: false,
      error: `Votre rôle ne donne pas accès à ${what}.`,
    });
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
      const caller = isProtected
        ? resolveCaller(req, url)
        : { identity: null, role: null as Role | null, token: '' };

      // Seuls `auth:status` et `auth:login` échappent à la connexion : ce sont
      // eux qui permettent de l'obtenir.
      const isPublicCall =
        req.method === 'POST' &&
        segments[0] === 'api' &&
        segments.length === 3 &&
        PUBLIC_CHANNELS.has(`${segments[1]}:${segments[2]}` as ChannelName);

      if (isProtected && !caller.role && !isPublicCall) {
        sendJson(res, 401, { ok: false, error: 'Connexion requise.', authRequired: true });
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
          // Ce cas n'arrive pas par hasard : les canaux sont générés de la même
          // liste des deux côtés. Un canal inconnu, c'est un poste plus récent
          // que le serveur — la seule chose à faire est de mettre le serveur à
          // jour, et c'est ce qu'il faut lire ici plutôt qu'un nom technique.
          sendJson(res, 404, {
            ok: false,
            error:
              `Canal inconnu : ${namespace}:${method}. Ce poste demande une fonction que ce ` +
              'serveur ne connaît pas encore : mettez le serveur à jour, puis redémarrez-le.',
          });
          return;
        }

        const channel = `${namespace}:${method}` as ChannelName;
        // Une liste vide veut dire « propre au poste ». On laisse alors le
        // gestionnaire répondre lui-même : son message explique quoi faire,
        // là où un refus de droits induirait en erreur.
        const desktopOnly = CHANNEL_ACCESS[channel]?.length === 0;
        if (!isPublicCall && !desktopOnly && !(caller.role && mayCall(caller.role, channel))) {
          refuse(res, caller, `« ${namespace} »`);
          return;
        }

        const raw = await readBody(req, JSON_LIMIT);
        const args: unknown[] = raw.length ? (JSON.parse(raw.toString('utf8')).args ?? []) : [];
        try {
          const result = await withContext(
            {
              identity: caller.identity,
              role: caller.role,
              token: caller.token,
              from: clientAddress(req),
            },
            () => handler(...args),
          );
          sendJson(res, 200, { ok: true, result: result ?? null });
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          console.error(`[serveur] ${namespace}:${method} :`, message);
          sendJson(res, 400, { ok: false, error: message });
        }
        return;
      }

      // --- Sauvegarde à emporter ---
      // C'est par ici qu'un poste rapatrie sa copie de sécurité, pour que les
      // données ne vivent pas uniquement sur le disque du serveur. La réponse
      // est la base entière : le droit exigé est donc celui de la sauvegarder,
      // et aucun autre ne saurait convenir.
      if (
        req.method === 'GET' &&
        segments[0] === 'files' &&
        segments.length === 2 &&
        segments[1] === 'backup'
      ) {
        if (!caller.role || !mayCall(caller.role, 'db:backup')) {
          refuse(res, caller, 'la sauvegarde de la base');
          return;
        }
        // Écrire d'abord : une copie prise à la milliseconde près d'une saisie
        // encore en mémoire serait une sauvegarde en retard d'une facture.
        store.flushSync();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        streamFile(res, store.dbFile, { downloadName: `backup-${stamp}.json` });
        return;
      }

      // --- Fichiers ---
      if (req.method === 'GET' && segments[0] === 'files' && segments.length === 3) {
        const [, kind, id] = segments;

        // Le même contrôle que sur les canaux : sans cela, deviner un
        // identifiant suffirait à récupérer une facture qu'on n'a pas le droit
        // de lire. Cacher le bouton dans l'interface ne protège rien.
        const needed: Record<string, ChannelName> = {
          document: 'documents:openFile',
          attachment: 'attachments:open',
          eml: 'documents:sendEmail',
        };
        const channel = needed[kind];
        if (!channel) {
          sendJson(res, 404, { ok: false, error: 'Type de fichier inconnu.' });
          return;
        }
        if (!caller.role || !mayCall(caller.role, channel)) {
          refuse(res, caller, 'ce fichier');
          return;
        }

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

        // Un téléversement appelle un gestionnaire : il exige donc le droit de
        // ce gestionnaire, pas moins.
        const needed: Record<string, ChannelName> = {
          clients: 'clients:importFrom',
          products: 'products:importFrom',
          bank: 'bank:importFrom',
          attachments: 'attachments:addFiles',
          documents: 'documents:addFiles',
          restore: 'db:restore',
        };
        const channel = needed[kind];
        if (!channel) {
          sendJson(res, 400, { ok: false, error: `Type de téléversement inconnu : ${kind}` });
          return;
        }
        if (!caller.role || !mayCall(caller.role, channel)) {
          refuse(res, caller, 'ce téléversement');
          return;
        }

        const fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
        // En-tête facultatif : seul un type connu est retenu, un intitulé
        // fantaisiste est ignoré plutôt que de créer un sous-dossier inattendu.
        const declared = String(req.headers['x-file-kind'] ?? '');
        const documentKind = (['invoice', 'quote', 'credit'] as const).find((k) => k === declared);
        const body = await readBody(req, UPLOAD_LIMIT);
        if (!body.length) {
          sendJson(res, 400, { ok: false, error: 'Fichier vide.' });
          return;
        }
        try {
          // Même contexte que pour un appel de canal : sans lui, l'import
          // n'aurait pas d'auteur et le poste qui vient d'envoyer le fichier
          // recevrait une notification pour son propre geste.
          const result = await withContext(
            {
              identity: caller.identity,
              role: caller.role,
              token: caller.token,
              from: clientAddress(req),
            },
            () => handleUpload(kind, fileName, body, documentKind),
          );
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
