import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '@shared/api';

/**
 * Construit `window.api` à partir de la table des canaux : chaque méthode
 * `api.<namespace>.<method>(...args)` devient `ipcRenderer.invoke('<ns>:<m>', ...args)`.
 * Aucun accès direct à Node n'est exposé à l'interface.
 */
const api: Record<string, unknown> = {};

for (const [namespace, methods] of Object.entries(CHANNELS)) {
  const group: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of methods as readonly string[]) {
    const channel = `${namespace}:${method}`;
    group[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
  }
  api[namespace] = group;
}

const PUSH_EVENTS = new Set(['documents-changed', 'scan-progress', 'toast', 'session-lost']);

api.on = (event: string, handler: (payload: unknown) => void) => {
  if (!PUSH_EVENTS.has(event)) throw new Error(`Événement inconnu : ${event}`);
  const listener = (_e: unknown, payload: unknown) => handler(payload);
  ipcRenderer.on(event, listener as never);
  return () => ipcRenderer.removeListener(event, listener as never);
};

contextBridge.exposeInMainWorld('api', api);
