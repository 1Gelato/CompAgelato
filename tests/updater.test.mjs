import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkForUpdates, applyUpdate, currentBuild } from './build/services.mjs';

const exec = promisify(execFile);

/**
 * Vérifie le mécanisme de mise à jour par git sur un vrai dépôt temporaire :
 * un dépôt « distant » (bare) et un clone « local », représentant le poste de
 * l'utilisateur et le dépôt GitHub.
 */

async function git(args, cwd) {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function makeRepoPair() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-updater-'));
  const remote = path.join(base, 'remote.git');
  const local = path.join(base, 'local');
  fs.mkdirSync(remote, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', remote], base);

  await git(['clone', remote, local], base);
  await git(['config', 'user.email', 'test@example.com'], local);
  await git(['config', 'user.name', 'Test'], local);

  // Un package.json minimal : applyUpdate doit pouvoir lancer `npm install`
  // et `npm run build` réellement, sans dépendre du vrai projet CompaGelato.
  fs.writeFileSync(
    path.join(local, 'package.json'),
    JSON.stringify(
      { name: 'fixture', version: '1.0.0', private: true, scripts: { build: 'node -e "process.exit(0)"' } },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(local, 'README.md'), 'version initiale\n');
  await git(['add', '-A'], local);
  await git(['commit', '-m', 'initial'], local);
  await git(['push', 'origin', 'main'], local);

  return { base, remote, local };
}

async function cleanup(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

test('supported: false hors d’un dépôt git', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-nogit-'));
  const result = await checkForUpdates(dir);
  assert.equal(result.supported, false);
  assert.match(result.reason, /pas été installée depuis le dossier cloné/i);
  assert.equal(result.available, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('le build annonce le commit réellement en place, et suit la mise à jour', async () => {
  // Le numéro de version ne bouge pas d'une mise à jour à l'autre : c'est
  // cette ligne, et elle seule, qui permet de dire si un poste a bien pris la
  // dernière version. Elle doit donc changer quand le code change.
  const { base, local, remote } = await makeRepoPair();
  try {
    const avant = await currentBuild(local);
    assert.ok(avant, 'aucun build annoncé sur un dépôt pourtant valide');
    assert.match(avant, /^[0-9a-f]{7,} · \d{4}-\d{2}-\d{2}$/, `format inattendu : ${avant}`);

    // Un commit de plus, tiré depuis le « distant » comme le ferait une mise à
    // jour : le build annoncé doit suivre.
    const autre = path.join(base, 'autre');
    await git(['clone', remote, autre], base);
    await git(['config', 'user.email', 'test@example.com'], autre);
    await git(['config', 'user.name', 'Test'], autre);
    fs.writeFileSync(path.join(autre, 'README.md'), 'version suivante\n');
    await git(['commit', '-am', 'suite'], autre);
    await git(['push', 'origin', 'main'], autre);
    await git(['pull', '--ff-only'], local);

    const apres = await currentBuild(local);
    assert.ok(apres);
    assert.notEqual(apres, avant, 'le build doit changer quand le code change');
  } finally {
    await cleanup(base);
  }
});

test('code à jour mais logiciel compilé avant : la mise à jour est proposée quand même', async () => {
  // Le piège que ce contrôle existe pour attraper : un `git pull` fait à la
  // main laisse le dépôt à jour et `dist/` en arrière. En ne comparant que les
  // commits, la vérification répondait « vous avez déjà la dernière version »
  // à un poste qui affichait pourtant l'ancienne interface — sans aucun bouton
  // pour en sortir.
  const { base, local } = await makeRepoPair();

  // Datation explicite plutôt que l'horloge : un commit et une compilation
  // faits dans la même seconde rendraient le test capricieux.
  const dated = (secondsFromNow) => {
    const when = new Date(Date.now() + secondsFromNow * 1000);
    for (const rel of [['dist', 'main', 'main.mjs'], ['dist', 'renderer', 'index.html']]) {
      const file = path.join(local, ...rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '', 'utf8');
      fs.utimesSync(file, when, when);
    }
  };

  try {
    // Un dépôt jamais compilé n'est pas un logiciel en retard : c'est un clone
    // tout neuf, et l'annoncer comme une mise à jour n'aiderait personne.
    let result = await checkForUpdates(local);
    assert.equal(result.staleBuild, false, 'un dist absent ne doit pas être pris pour un retard');
    assert.equal(result.available, false);

    // Compilation postérieure au dernier commit : rien à signaler.
    dated(3600);
    result = await checkForUpdates(local);
    assert.equal(result.staleBuild, false, 'une compilation postérieure au commit est à jour');
    assert.equal(result.available, false);

    // Compilation antérieure : c'est exactement l'état où l'écran annonçait
    // « vous avez déjà la dernière version » en affichant l'ancienne interface.
    dated(-3600);
    result = await checkForUpdates(local);
    assert.equal(result.staleBuild, true, 'une compilation antérieure au commit doit être vue');
    assert.equal(result.available, true, 'le bouton doit rester atteignable');
    assert.equal(result.behind, 0, 'aucun commit ne manque pourtant : rien à tirer, tout à recompiler');
  } finally {
    await cleanup(base);
  }
});

test('commit détaché : on dit que la comparaison a échoué, pas que tout va bien', async () => {
  // Le mensonge qui a coûté une soirée : sans branche suivie, `origin/<branche>`
  // ne se résout pas, la comparaison ne donne rien — et l'écran annonçait
  // pourtant « vous avez déjà la dernière version » à un poste resté des
  // semaines en arrière.
  const { base, local } = await makeRepoPair();
  try {
    // Un commit de plus sur le distant, pour qu'il y ait réellement du retard.
    const autre = path.join(base, 'autre-detache');
    await git(['clone', path.join(base, 'remote.git'), autre], base);
    await git(['config', 'user.email', 'test@example.com'], autre);
    await git(['config', 'user.name', 'Test'], autre);
    fs.writeFileSync(path.join(autre, 'README.md'), 'nouveauté\n');
    await git(['commit', '-am', 'nouveauté'], autre);
    await git(['push', 'origin', 'main'], autre);

    // Le poste se détache de sa branche : c'est l'état constaté sur le terrain.
    const head = await git(['rev-parse', 'HEAD'], local);
    await git(['checkout', '--detach', head], local);

    const result = await checkForUpdates(local);
    assert.equal(result.supported, true);
    assert.ok(result.reason, 'un échec de comparaison doit être signalé, jamais tu');
    assert.match(result.reason, /détaché|aucune branche suivie/i);
    assert.equal(result.behind, 0);
  } finally {
    await cleanup(base);
  }
});

test('hors d’un dépôt git, le build est absent sans faire échouer l’écran', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-nogit-build-'));
  assert.equal(await currentBuild(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('aucune mise à jour disponible quand le dépôt local est à jour', async () => {
  const { base, local } = await makeRepoPair();
  try {
    const result = await checkForUpdates(local);
    assert.equal(result.supported, true);
    assert.equal(result.available, false);
    assert.equal(result.behind, 0);
    assert.equal(result.branch, 'main');
    assert.ok(result.currentCommit, 'commit courant manquant');
  } finally {
    await cleanup(base);
  }
});

test('détecte une mise à jour disponible avec le résumé des commits', async () => {
  const { base, remote, local } = await makeRepoPair();
  try {
    // Simule un second poste qui pousse deux nouveaux commits sur le dépôt distant.
    const other = path.join(base, 'other');
    await git(['clone', remote, other], base);
    await git(['config', 'user.email', 'test@example.com'], other);
    await git(['config', 'user.name', 'Test'], other);
    fs.writeFileSync(path.join(other, 'README.md'), 'version 2\n');
    await git(['add', '-A'], other);
    await git(['commit', '-m', 'Deuxieme amelioration'], other);
    fs.writeFileSync(path.join(other, 'README.md'), 'version 3\n');
    await git(['add', '-A'], other);
    await git(['commit', '-m', 'Troisieme amelioration'], other);
    await git(['push', 'origin', 'main'], other);

    const result = await checkForUpdates(local);
    assert.equal(result.supported, true);
    assert.equal(result.available, true);
    assert.equal(result.behind, 2);
    assert.deepEqual(result.changes, ['Troisieme amelioration', 'Deuxieme amelioration']);
    assert.notEqual(result.remoteCommit, result.currentCommit);
  } finally {
    await cleanup(base);
  }
});

test('applyUpdate récupère les commits, installe et reconstruit', async () => {
  const { base, remote, local } = await makeRepoPair();
  try {
    const other = path.join(base, 'other');
    await git(['clone', remote, other], base);
    await git(['config', 'user.email', 'test@example.com'], other);
    await git(['config', 'user.name', 'Test'], other);
    fs.writeFileSync(path.join(other, 'README.md'), 'version 2\n');
    await git(['add', '-A'], other);
    await git(['commit', '-m', 'Amelioration'], other);
    await git(['push', 'origin', 'main'], other);

    const steps = [];
    const result = await applyUpdate(local, (s) => steps.push(s));

    assert.equal(result.success, true, result.message);
    assert.match(result.message, /redémarrez/i);
    assert.deepEqual(steps, [
      'Vérification des modifications locales…',
      'Téléchargement de la dernière version…',
      'Installation des dépendances…',
      'Préparation du logiciel…',
    ]);

    // Le contenu doit refléter la mise à jour tirée du dépôt distant.
    assert.equal(fs.readFileSync(path.join(local, 'README.md'), 'utf8'), 'version 2\n');

    const after = await checkForUpdates(local);
    assert.equal(after.available, false, 'le dépôt doit être à jour après applyUpdate');
  } finally {
    await cleanup(base);
  }
});

test('applyUpdate refuse quand un fichier suivi a été modifié, et le nomme', async () => {
  const { base, local } = await makeRepoPair();
  try {
    fs.writeFileSync(path.join(local, 'README.md'), 'modification locale non commitée\n');
    const result = await applyUpdate(local);
    assert.equal(result.success, false);
    assert.match(result.message, /modifiés sur ce poste/i);
    // Le fichier fautif est nommé, pour que l'utilisateur sache quoi réparer.
    assert.deepEqual(result.localChanges, ['README.md']);
    // Aucune action destructive tant que la réparation n'est pas demandée.
    assert.equal(fs.readFileSync(path.join(local, 'README.md'), 'utf8'), 'modification locale non commitée\n');
  } finally {
    await cleanup(base);
  }
});

test('les fichiers non suivis ne bloquent jamais la mise à jour', async () => {
  // Cas réel : le dossier de travail (factures, relevés) se trouve à
  // l'intérieur du dossier du logiciel. Ces fichiers n'ont rien à voir avec le
  // code et ne doivent pas empêcher la mise à jour — ni être touchés.
  const { base, remote, local } = await makeRepoPair();
  try {
    const other = path.join(base, 'other');
    await git(['clone', remote, other], base);
    await git(['config', 'user.email', 'test@example.com'], other);
    await git(['config', 'user.name', 'Test'], other);
    fs.writeFileSync(path.join(other, 'README.md'), 'version 2\n');
    await git(['add', '-A'], other);
    await git(['commit', '-m', 'Amelioration'], other);
    await git(['push', 'origin', 'main'], other);

    fs.mkdirSync(path.join(local, 'Factures'), { recursive: true });
    fs.writeFileSync(path.join(local, 'Factures', 'FAC00000669.pdf'), 'facture du client');
    fs.writeFileSync(path.join(local, 'LISEZ-MOI.txt'), 'dossier de travail');

    const result = await applyUpdate(local);
    assert.equal(result.success, true, result.message);
    assert.equal(fs.readFileSync(path.join(local, 'README.md'), 'utf8'), 'version 2\n');
    // Les documents de l'utilisateur sont intacts.
    assert.equal(
      fs.readFileSync(path.join(local, 'Factures', 'FAC00000669.pdf'), 'utf8'),
      'facture du client',
    );
    assert.equal(fs.readFileSync(path.join(local, 'LISEZ-MOI.txt'), 'utf8'), 'dossier de travail');
  } finally {
    await cleanup(base);
  }
});

test('« réparer » rétablit les fichiers du logiciel sans toucher aux documents', async () => {
  const { base, remote, local } = await makeRepoPair();
  try {
    const other = path.join(base, 'other');
    await git(['clone', remote, other], base);
    await git(['config', 'user.email', 'test@example.com'], other);
    await git(['config', 'user.name', 'Test'], other);
    fs.writeFileSync(path.join(other, 'README.md'), 'version 2\n');
    await git(['add', '-A'], other);
    await git(['commit', '-m', 'Amelioration'], other);
    await git(['push', 'origin', 'main'], other);

    // Un fichier du logiciel abîmé, et un document de l'utilisateur à côté.
    fs.writeFileSync(path.join(local, 'README.md'), 'abime\n');
    fs.mkdirSync(path.join(local, 'Factures'), { recursive: true });
    fs.writeFileSync(path.join(local, 'Factures', 'FAC00000669.pdf'), 'facture du client');

    const steps = [];
    const result = await applyUpdate(local, (s) => steps.push(s), { discardLocalChanges: true });

    assert.equal(result.success, true, result.message);
    assert.ok(steps.includes('Rétablissement des fichiers du logiciel…'));
    // Le fichier du logiciel est rétabli *et* mis à jour.
    assert.equal(fs.readFileSync(path.join(local, 'README.md'), 'utf8'), 'version 2\n');
    // Le document de l'utilisateur n'a pas bougé.
    assert.equal(
      fs.readFileSync(path.join(local, 'Factures', 'FAC00000669.pdf'), 'utf8'),
      'facture du client',
    );
  } finally {
    await cleanup(base);
  }
});
