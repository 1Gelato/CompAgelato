import type { Api } from '@shared/api';
import { CHANNELS } from '@shared/api';

/**
 * `window.api` version navigateur.
 *
 * Quand l'interface est servie par le serveur CompaGelato (et non par
 * l'application de bureau), il n'y a pas de pont Electron : cet adaptateur
 * construit exactement le même objet `window.api` à partir de la même table
 * `CHANNELS`, en parlant HTTP au serveur qui a servi la page. Les écrans ne
 * voient aucune différence.
 *
 * Les actions qui ouvrent une fenêtre sur le poste (sélecteurs de fichiers,
 * visionneuse, messagerie) sont traduites en gestes de navigateur : ouverture
 * d'onglet, téléchargement, champ de fichier.
 */

const TOKEN_KEY = 'compagelato-token';

/** Jeton d'accès : lu dans l'adresse (`?token=…`) puis mémorisé sur l'appareil. */
function readToken(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('token');
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl);
      // L'adresse est nettoyée pour ne pas laisser traîner le jeton dans l'historique.
      const clean = new URL(window.location.href);
      clean.searchParams.delete('token');
      window.history.replaceState(null, '', clean.toString());
      return fromUrl;
    }
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

let token = '';

function withToken(url: string): string {
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

async function call(namespace: string, method: string, args: unknown[]): Promise<unknown> {
  const response = await fetch(`/api/${namespace}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-auth-token': token } : {}),
    },
    body: JSON.stringify({ args }),
  });
  let payload: { ok?: boolean; result?: unknown; error?: string };
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Le serveur a répondu ${response.status} sans détail.`);
  }
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Erreur ${response.status}.`);
  }
  return payload.result;
}

/* ------------------------------------------------------------------ */
/* Téléversements : le « choisir un fichier » du navigateur             */
/* ------------------------------------------------------------------ */

function pickLocalFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    // Annulation : l'événement `cancel` existe désormais dans les navigateurs.
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    input.click();
  });
}

async function upload(kind: string, file: File): Promise<unknown> {
  const response = await fetch(withToken(`/upload/${kind}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      ...(token ? { 'x-auth-token': token } : {}),
    },
    body: file,
  });
  const payload = (await response.json()) as { ok?: boolean; result?: unknown; error?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Erreur ${response.status}.`);
  return payload.result;
}

async function pickAndUpload(kind: string, accept: string): Promise<unknown | null> {
  const [file] = await pickLocalFiles(accept, false);
  if (!file) return null;
  return upload(kind, file);
}

/* ------------------------------------------------------------------ */
/* Flux d'événements                                                    */
/* ------------------------------------------------------------------ */

type EventHandler = (payload: unknown) => void;
const listeners = new Map<string, Set<EventHandler>>();
let source: EventSource | null = null;

function ensureEventSource(): void {
  if (source) return;
  source = new EventSource(withToken('/api/events'));
  source.onmessage = (event) => {
    try {
      const { channel, payload } = JSON.parse(event.data) as { channel: string; payload: unknown };
      for (const handler of listeners.get(channel) ?? []) handler(payload);
    } catch {
      /* trame illisible : ignorée */
    }
  };
  // En cas de coupure, EventSource retente tout seul : rien à faire.
}

/* ------------------------------------------------------------------ */
/* Construction de l'objet Api                                          */
/* ------------------------------------------------------------------ */

export function createHttpApi(): Api {
  token = readToken();

  // Le socle : chaque canal déclaré devient un appel HTTP.
  const api = {} as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> & {
    on?: unknown;
  };
  for (const [namespace, methods] of Object.entries(CHANNELS)) {
    api[namespace] = {};
    for (const method of methods as readonly string[]) {
      api[namespace][method] = (...args: unknown[]) => call(namespace, method, args);
    }
  }

  /* Surcharges navigateur : mêmes signatures, gestes adaptés. */

  api.app.openExternal = async (url) => {
    window.open(String(url), '_blank', 'noopener');
  };

  api.documents.openFile = async (documentId) => {
    window.open(withToken(`/files/document/${documentId}`), '_blank', 'noopener');
  };

  api.documents.print = async (documentId) => {
    // Le PDF s'ouvre dans un onglet ; l'impression se fait depuis la visionneuse.
    window.open(withToken(`/files/document/${documentId}`), '_blank', 'noopener');
    return call('documents', 'print', [documentId]);
  };

  api.documents.sendEmail = async (documentId, draft) => {
    const outcome = (await call('documents', 'sendEmail', [documentId, draft])) as {
      fileUrl?: string;
    };
    // Le brouillon .eml préparé par le serveur est téléchargé : un double-clic
    // dessus l'ouvre dans la messagerie avec toutes les pièces jointes.
    if (outcome.fileUrl) window.open(withToken(outcome.fileUrl), '_blank', 'noopener');
    return outcome;
  };

  api.attachments.open = async (id) => {
    window.open(withToken(`/files/attachment/${id}`), '_blank', 'noopener');
  };

  api.attachments.pickAndAdd = async () => {
    const files = await pickLocalFiles('.pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.xlsx,.pptx', true);
    if (!files.length) return null;
    const added: unknown[] = [];
    for (const file of files) {
      const result = (await upload('attachments', file)) as unknown[];
      added.push(...result);
    }
    return added;
  };

  api.clients.pickAndImport = () => pickAndUpload('clients', '.csv,.xlsx,.xls,.txt');
  api.products.pickAndImport = () => pickAndUpload('products', '.csv,.xlsx,.xls,.txt');
  api.bank.pickAndImport = () => pickAndUpload('bank', '.csv,.xlsx,.xls,.xlsm');

  api.db.restore = async (filePath) => {
    if (filePath) return call('db', 'restore', [filePath]);
    const result = await pickAndUpload('restore', '.json');
    return result ?? false;
  };

  const on: Api['on'] = (event, handler) => {
    ensureEventSource();
    const set = listeners.get(event) ?? new Set();
    set.add(handler as EventHandler);
    listeners.set(event, set);
    return () => {
      set.delete(handler as EventHandler);
    };
  };
  api.on = on;

  return api as unknown as Api;
}

/** L'interface tourne-t-elle dans un navigateur, servie par le serveur ? */
export function isBrowserMode(): boolean {
  return typeof window !== 'undefined' && !window.api;
}
