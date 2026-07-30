import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execCb);

/**
 * Mise à jour par git : CompaGelato tourne depuis une copie clonée du dépôt
 * (lancée via `npm start` / le raccourci) plutôt que depuis un installateur
 * publié. Vérifier et appliquer une mise à jour revient donc à faire, sans
 * taper de commande, ce que l'utilisateur ferait à la main : `git fetch`,
 * comparer avec la branche distante, puis `git pull` + reconstruction.
 */

const GIT_TIMEOUT_MS = 20000;
const BUILD_TIMEOUT_MS = 180000;

export interface UpdateCheckResult {
  supported: boolean;
  reason?: string;
  branch?: string;
  currentCommit?: string;
  remoteCommit?: string;
  available: boolean;
  behind: number;
  /** Résumé des commits manquants, du plus récent au plus ancien. */
  changes: string[];
}

export interface UpdateApplyResult {
  success: boolean;
  message: string;
  log: string;
}

function isGitCheckout(root: string): boolean {
  try {
    return fs.statSync(path.join(root, '.git')).isDirectory();
  } catch {
    return false;
  }
}

async function run(command: string, cwd: string, timeout: number): Promise<string> {
  const { stdout } = await exec(command, { cwd, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export async function checkForUpdates(root: string): Promise<UpdateCheckResult> {
  if (!isGitCheckout(root)) {
    return {
      supported: false,
      reason:
        "Cette copie de CompaGelato n'a pas été installée depuis le dossier cloné du dépôt : la mise à jour automatique n'est pas disponible ici.",
      available: false,
      behind: 0,
      changes: [],
    };
  }

  let branch: string;
  try {
    branch = await run('git rev-parse --abbrev-ref HEAD', root, GIT_TIMEOUT_MS);
  } catch {
    return {
      supported: false,
      reason: "Impossible de déterminer la branche du dépôt local.",
      available: false,
      behind: 0,
      changes: [],
    };
  }

  const currentCommit = await run('git rev-parse HEAD', root, GIT_TIMEOUT_MS).catch(() => undefined);

  try {
    await run(`git fetch origin ${branch} --quiet`, root, GIT_TIMEOUT_MS);
  } catch (err) {
    return {
      supported: true,
      reason: `Vérification impossible : ${extractGitError(err)}. Vérifiez votre connexion internet.`,
      branch,
      currentCommit,
      available: false,
      behind: 0,
      changes: [],
    };
  }

  const remoteCommit = await run(`git rev-parse origin/${branch}`, root, GIT_TIMEOUT_MS).catch(() => undefined);
  if (!remoteCommit || remoteCommit === currentCommit) {
    return {
      supported: true,
      branch,
      currentCommit,
      remoteCommit,
      available: false,
      behind: 0,
      changes: [],
    };
  }

  const behindRaw = await run(`git rev-list --count HEAD..origin/${branch}`, root, GIT_TIMEOUT_MS).catch(() => '0');
  const behind = Number(behindRaw) || 0;

  const log = await run(
    `git log --pretty=format:%s HEAD..origin/${branch}`,
    root,
    GIT_TIMEOUT_MS,
  ).catch(() => '');
  const changes = log.split('\n').filter(Boolean).slice(0, 12);

  return {
    supported: true,
    branch,
    currentCommit,
    remoteCommit,
    available: behind > 0,
    behind,
    changes,
  };
}

function extractGitError(err: unknown): string {
  const message = (err as { message?: string })?.message ?? String(err);
  // Ne garde que la première ligne utile : les messages git peuvent être longs.
  return message.split('\n').find((l) => l.trim().length) ?? 'erreur inconnue';
}

/**
 * Applique la mise à jour : bascule sur les derniers commits puis reconstruit.
 * Refuse si des modifications locales existent (aucune ne devrait exister sur
 * un poste utilisateur, mais on ne prend pas de risque avec les données).
 */
export async function applyUpdate(
  root: string,
  onProgress?: (step: string) => void,
): Promise<UpdateApplyResult> {
  const log: string[] = [];
  const step = (label: string) => {
    log.push(label);
    onProgress?.(label);
  };

  if (!isGitCheckout(root)) {
    return { success: false, message: 'Mise à jour automatique indisponible sur cette installation.', log: '' };
  }

  try {
    step('Vérification des modifications locales…');
    const status = await run('git status --porcelain', root, GIT_TIMEOUT_MS);
    if (status) {
      return {
        success: false,
        message:
          'Des modifications locales inattendues ont été trouvées dans le dossier du logiciel : la mise à jour a été annulée par précaution. Contactez le support.',
        log: log.join('\n') + '\n' + status,
      };
    }

    const branch = await run('git rev-parse --abbrev-ref HEAD', root, GIT_TIMEOUT_MS);

    step('Téléchargement de la dernière version…');
    const pullOut = await run(`git pull --ff-only origin ${branch}`, root, GIT_TIMEOUT_MS);
    log.push(pullOut);

    step('Installation des dépendances…');
    const installOut = await run('npm install --no-audit --no-fund', root, BUILD_TIMEOUT_MS);
    log.push(installOut);

    step('Préparation du logiciel…');
    const buildOut = await run('npm run build', root, BUILD_TIMEOUT_MS);
    log.push(buildOut);

    return {
      success: true,
      message: 'Mise à jour installée. Redémarrez CompaGelato pour l’utiliser.',
      log: log.join('\n'),
    };
  } catch (err) {
    return {
      success: false,
      message: `La mise à jour a échoué : ${extractGitError(err)}`,
      log: log.join('\n'),
    };
  }
}
