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
  /**
   * Le code est à jour, mais le logiciel qui s'exécute a été compilé avant :
   * `dist/` est plus ancien que le dernier commit.
   *
   * Sans ce contrôle, la vérification ne compare que des commits et répond
   * « vous avez déjà la dernière version » à un poste qui affiche pourtant
   * l'ancienne interface — un `git pull` fait à la main suffit à provoquer cet
   * état, et aucun bouton n'en sortait.
   */
  staleBuild?: boolean;
}

export interface UpdateApplyResult {
  success: boolean;
  message: string;
  log: string;
  /**
   * Fichiers du logiciel modifiés localement qui ont bloqué la mise à jour.
   * Permet de les afficher à l'utilisateur et de proposer la réparation.
   */
  localChanges?: string[];
}

export interface UpdateApplyOptions {
  /**
   * Rétablit les fichiers du logiciel modifiés localement avant de mettre à
   * jour. Les données (base, documents, relevés) ne sont jamais concernées :
   * elles vivent hors du dossier de code.
   */
  discardLocalChanges?: boolean;
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

/**
 * Le commit d'où tourne cette copie, et sa date — `a1b2c3d · 2026-08-07`.
 *
 * Le numéro de version du `package.json` ne bouge pas d'une mise à jour à
 * l'autre : il annoncerait « 1.0.0 » sur toutes les copies, quel que soit le
 * code réellement exécuté, et ne permettrait donc pas de répondre à la seule
 * question qui se pose en pratique — « ce poste a-t-il bien pris la dernière
 * mise à jour ? ». Le commit, lui, répond sans rien demander à personne.
 *
 * Relu à chaque appel plutôt que mis en cache : l'appel ne coûte que quelques
 * millisecondes, sur un écran qu'on ouvre rarement, et une valeur mémorisée
 * finirait par annoncer un commit que le dossier ne contient plus.
 */
export async function currentBuild(root: string): Promise<string | null> {
  if (!isGitCheckout(root)) return null;
  try {
    // Guillemets indispensables : la commande passe par un shell, et une chaîne
    // de format contenant une espace serait découpée en arguments — git prendrait
    // le reste pour des révisions, et échouerait.
    const line = await run('git log -1 --format="%h · %cs"', root, GIT_TIMEOUT_MS);
    return line || null;
  } catch {
    // Git absent ou dépôt illisible : l'écran « À propos » s'affiche sans cette
    // ligne plutôt que de refuser de s'ouvrir.
    return null;
  }
}

/**
 * Le logiciel compilé est-il plus vieux que le code présent ?
 *
 * On compare les sorties de compilation à la date du dernier commit. Une sortie
 * **absente** n'est délibérément pas comptée comme périmée : le programme qui
 * pose la question s'exécute depuis ces fichiers, ils existent donc forcément.
 * Un dossier jamais compilé n'est pas un logiciel en retard, c'est un dépôt
 * qu'on vient de cloner — et l'annoncer comme une mise à jour disponible
 * n'aiderait personne.
 */
export function buildIsStale(root: string, commitEpochSeconds: number): boolean {
  const outputs = [
    path.join(root, 'dist', 'main', 'main.mjs'),
    path.join(root, 'dist', 'renderer', 'index.html'),
  ];
  for (const file of outputs) {
    try {
      if (fs.statSync(file).mtimeMs / 1000 < commitEpochSeconds) return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function commitEpoch(root: string): Promise<number | null> {
  try {
    const raw = await run('git log -1 --format=%ct', root, GIT_TIMEOUT_MS);
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
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

  // Indépendant du dépôt distant : un `git pull` fait à la main laisse le code
  // à jour et le logiciel compilé en arrière. Se contenter de comparer les
  // commits reviendrait alors à affirmer que tout va bien devant un écran qui
  // montre le contraire.
  const epoch = await commitEpoch(root);
  const staleBuild = epoch !== null && buildIsStale(root, epoch);

  try {
    await run(`git fetch origin ${branch} --quiet`, root, GIT_TIMEOUT_MS);
  } catch (err) {
    return {
      supported: true,
      // Sans réseau mais compilation en retard : la reconstruction, elle, est
      // possible tout de suite et suffit à retrouver l'interface attendue.
      reason: staleBuild
        ? undefined
        : `Vérification impossible : ${extractGitError(err)}. Vérifiez votre connexion internet.`,
      branch,
      currentCommit,
      available: staleBuild,
      behind: 0,
      changes: [],
      staleBuild,
    };
  }

  const remoteCommit = await run(`git rev-parse origin/${branch}`, root, GIT_TIMEOUT_MS).catch(() => undefined);

  // Branche distante introuvable — le poste est sur un commit détaché, ou sur
  // une branche qui n'existe pas sur le dépôt. La comparaison n'a alors rien
  // donné, et l'annoncer comme « vous avez déjà la dernière version » est un
  // mensonge : c'est précisément l'état où l'on reste des semaines en arrière
  // avec un écran qui affirme le contraire. On le dit, et on dit quoi faire.
  if (!remoteCommit) {
    return {
      supported: true,
      reason:
        `Impossible de situer « ${branch} » sur le dépôt : ce poste n'est probablement ` +
        `sur aucune branche suivie (commit détaché). Aucune comparaison n'a pu être faite — ` +
        `l'état de ce poste vis-à-vis du dépôt est inconnu.`,
      branch,
      currentCommit,
      available: staleBuild,
      behind: 0,
      changes: [],
      staleBuild,
    };
  }

  if (remoteCommit === currentCommit) {
    return {
      supported: true,
      branch,
      currentCommit,
      remoteCommit,
      available: staleBuild,
      behind: 0,
      changes: [],
      staleBuild,
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
    available: behind > 0 || staleBuild,
    behind,
    changes,
    staleBuild,
  };
}

function extractGitError(err: unknown): string {
  const message = (err as { message?: string })?.message ?? String(err);
  // Ne garde que la première ligne utile : les messages git peuvent être longs.
  return message.split('\n').find((l) => l.trim().length) ?? 'erreur inconnue';
}

/**
 * Applique la mise à jour : bascule sur les derniers commits puis reconstruit.
 *
 * Seules les modifications de fichiers *suivis* bloquent. Les fichiers non
 * suivis sont ignorés à dessein : sur un poste où le dossier de travail
 * (factures, relevés) se trouve à l'intérieur du dossier du logiciel, ils sont
 * légion et n'ont rien à voir avec le code. Ils ne risquent rien non plus :
 * `git pull --ff-only` refuse de lui-même d'écraser un fichier non suivi.
 */
export async function applyUpdate(
  root: string,
  onProgress?: (step: string) => void,
  options: UpdateApplyOptions = {},
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
    // --untracked-files=no : ne regarde que les fichiers du logiciel.
    const status = await run('git status --porcelain --untracked-files=no', root, GIT_TIMEOUT_MS);
    if (status) {
      // Format porcelain : deux caractères d'état puis le chemin. La sortie
      // étant élaguée, le premier état peut avoir perdu son espace de tête :
      // on retire donc l'état par motif plutôt qu'à position fixe.
      const localChanges = status
        .split('\n')
        .map((l) => l.trim().replace(/^\S{1,2}\s+/, ''))
        .filter(Boolean);

      if (!options.discardLocalChanges) {
        return {
          success: false,
          message:
            `Des fichiers du logiciel ont été modifiés sur ce poste (${localChanges.length}) : ` +
            'la mise à jour a été annulée par précaution. Utilisez « Réparer et installer » ' +
            'pour rétablir ces fichiers puis mettre à jour — vos données ne sont pas concernées.',
          log: log.join('\n') + '\n' + status,
          localChanges,
        };
      }

      step('Rétablissement des fichiers du logiciel…');
      // Ne touche qu'aux fichiers suivis : les documents déposés par
      // l'utilisateur, non suivis, restent intacts.
      await run('git checkout -- .', root, GIT_TIMEOUT_MS);
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
