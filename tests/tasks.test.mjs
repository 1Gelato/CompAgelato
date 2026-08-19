import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dataStore,
  upsertTask,
  trashTask,
  restoreTask,
  purgeTask,
  setTaskStatus,
  listTasks,
  listTaskPeople,
  withContext,
  setActivityPublisher,
  shouldNotify,
  DEFAULT_DESKTOP_NOTIFY,
} from './build/services.mjs';

/**
 * Le suivi des tâches repose sur trois promesses faites à l'utilisateur :
 * l'urgent s'affiche d'abord, rien ne se perd jamais (corbeille + journal),
 * et l'équipe est prévenue — sauf l'auteur du geste. Chaque promesse est
 * figée ici.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-taches-'));

test.before(() => {
  dataStore.init({
    dataDir: path.join(dir, 'donnees'),
    documentsDir: path.join(dir, 'Documents'),
  });
});

test.after(() => {
  dataStore.flushSync();
  fs.rmSync(dir, { recursive: true, force: true });
});

const QUENTIN = {
  userId: 'usr_quentin',
  username: 'quentin',
  displayName: 'Quentin',
  role: 'gerant',
};

/** Exécute un geste comme s'il venait de Quentin, connecté au serveur. */
function enTantQueQuentin(run) {
  return withContext({ identity: QUENTIN, role: 'gerant', token: '', from: 'test' }, run);
}

/* ------------------------------------------------------------------ */
/* Priorités : l'urgent d'abord, toujours                               */
/* ------------------------------------------------------------------ */

test('le tri met l’urgent d’abord, puis l’échéance la plus proche', () => {
  const basse = upsertTask({ title: 'Ranger l’atelier', priority: 'low' });
  const urgente = upsertTask({ title: 'Rappeler le camping', priority: 'urgent' });
  const demain = upsertTask({ title: 'Envoyer le devis', priority: 'high', dueDate: '2026-08-20' });
  const semaine = upsertTask({ title: 'Commander le mix', priority: 'high', dueDate: '2026-08-25' });

  const ordre = listTasks().map((t) => t.id);
  assert.equal(ordre[0], urgente.id, 'l’urgent passe devant tout');
  assert.ok(
    ordre.indexOf(demain.id) < ordre.indexOf(semaine.id),
    'à priorité égale, l’échéance la plus proche d’abord',
  );
  assert.equal(ordre[ordre.length - 1], basse.id, 'la priorité basse ferme la marche');

  for (const t of [basse, urgente, demain, semaine]) purgeAfterTrash(t.id);
});

/** Nettoyage : corbeille puis purge, pour que chaque test reparte à vide. */
function purgeAfterTrash(id) {
  trashTask(id);
  purgeTask(id);
}

test('une priorité inconnue retombe sur « normale » au lieu de casser le tri', () => {
  const t = upsertTask({ title: 'Tâche au rejeu douteux', priority: 'p1-critique' });
  assert.equal(t.priority, 'normal');
  purgeAfterTrash(t.id);
});

/* ------------------------------------------------------------------ */
/* Rien ne se perd : corbeille, restauration, purge                     */
/* ------------------------------------------------------------------ */

test('« supprimer » met à la corbeille, et la restauration rend tout', () => {
  const t = upsertTask({
    title: 'Relancer SNSM LE CROISIC',
    details: 'Facture impayée depuis juin',
    priority: 'high',
    dueDate: '2026-08-30',
  });

  trashTask(t.id);
  const aLaCorbeille = listTasks().find((x) => x.id === t.id);
  assert.ok(aLaCorbeille.deletedAt, 'la tâche est marquée, pas effacée');
  assert.equal(aLaCorbeille.title, 'Relancer SNSM LE CROISIC', 'rien n’est perdu en attendant');

  restoreTask(t.id);
  const revenue = listTasks().find((x) => x.id === t.id);
  assert.equal(revenue.deletedAt, undefined);
  assert.equal(revenue.details, 'Facture impayée depuis juin');
  assert.equal(revenue.dueDate, '2026-08-30');
  purgeAfterTrash(t.id);
});

test('la purge refuse une tâche vivante : le filet ne se saute pas', () => {
  const t = upsertTask({ title: 'Tâche bien vivante' });
  assert.throws(() => purgeTask(t.id), /corbeille/);
  assert.ok(listTasks().some((x) => x.id === t.id));
  purgeAfterTrash(t.id);
});

test('la corbeille se vide seule après trente jours', () => {
  const t = upsertTask({ title: 'Vieille tâche oubliée' });
  trashTask(t.id);
  // On antidate la mise à la corbeille : trente et un jours ont « passé ».
  dataStore.mutate((db) => {
    const row = db.tasks.find((x) => x.id === t.id);
    row.deletedAt = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  });

  assert.ok(
    !listTasks().some((x) => x.id === t.id),
    'la lecture a purgé la tâche expirée',
  );
});

test('vider la corbeille n’emporte que la corbeille', () => {
  const vivante = upsertTask({ title: 'Toujours à faire' });
  const jetee = upsertTask({ title: 'Créée par erreur' });
  trashTask(jetee.id);

  const { purged } = purgeTask();
  assert.equal(purged, 1);
  assert.ok(listTasks().some((x) => x.id === vivante.id));
  assert.ok(!listTasks().some((x) => x.id === jetee.id));
  purgeAfterTrash(vivante.id);
});

/* ------------------------------------------------------------------ */
/* Le journal : qui a fait quoi, quand                                  */
/* ------------------------------------------------------------------ */

test('chaque geste s’inscrit au journal avec son auteur', () => {
  const t = enTantQueQuentin(() =>
    upsertTask({ title: 'Vérifier la vitrine', priority: 'normal' }),
  );
  assert.equal(t.history[0].text, 'créée');
  assert.equal(t.history[0].by, 'usr_quentin');
  assert.equal(t.history[0].byName, 'Quentin');
  assert.equal(t.createdByName, 'Quentin');

  enTantQueQuentin(() => upsertTask({ id: t.id, priority: 'urgent', dueDate: '2026-08-21' }));
  const apres = listTasks().find((x) => x.id === t.id);
  assert.match(apres.history[0].text, /priorité Normale → Urgent/);
  assert.match(apres.history[0].text, /échéance fixée au 21\/08\/2026/);

  // Une sauvegarde sans différence ne laisse aucune trace : le journal
  // raconte ce qui change, pas ce qui est envoyé.
  const lignes = apres.history.length;
  upsertTask({ id: t.id, priority: 'urgent' });
  assert.equal(listTasks().find((x) => x.id === t.id).history.length, lignes);
  purgeAfterTrash(t.id);
});

test('marquer fait puis se raviser : doneAt suit, le journal garde les deux gestes', () => {
  const t = upsertTask({ title: 'Nettoyer la machine 2' });
  setTaskStatus(t.id, 'done');
  let lu = listTasks().find((x) => x.id === t.id);
  assert.ok(lu.doneAt, 'la date de réalisation est posée');

  // L'erreur de clic se défait d'un geste : c'est le retour en arrière promis.
  setTaskStatus(t.id, 'open');
  lu = listTasks().find((x) => x.id === t.id);
  assert.equal(lu.doneAt, undefined);
  assert.match(lu.history[0].text, /statut Fait → À faire/);
  assert.match(lu.history[1].text, /statut À faire → Fait/);
  purgeAfterTrash(t.id);
});

/* ------------------------------------------------------------------ */
/* Notifications : l'équipe est prévenue, jamais l'auteur               */
/* ------------------------------------------------------------------ */

test('créer une tâche l’annonce aux postes, signée de son auteur', () => {
  const annonces = [];
  setActivityPublisher((event) => annonces.push(event));
  try {
    const t = enTantQueQuentin(() =>
      upsertTask({ title: 'Rappeler le glacier de Pornichet', priority: 'urgent' }),
    );
    assert.equal(annonces.length, 1);
    assert.equal(annonces[0].source, 'task');
    assert.match(annonces[0].title, /Rappeler le glacier de Pornichet/);
    assert.equal(annonces[0].by, 'usr_quentin', 'le poste de Quentin saura se taire');

    // Modifier ou jeter ne réveille personne : seule l'arrivée compte.
    upsertTask({ id: t.id, priority: 'low' });
    trashTask(t.id);
    assert.equal(annonces.length, 1);
    purgeTask(t.id);
  } finally {
    setActivityPublisher(() => {});
  }
});

test('la bulle « tâches » se coupe depuis les réglages, sans toucher au reste', () => {
  const evenement = {
    source: 'task',
    title: 'Nouvelle tâche — Rappeler le camping',
    text: 'priorité urgente',
    by: 'usr_herve',
    at: '2026-08-19T09:00:00.000Z',
  };
  const contexte = { myUserId: 'usr_quentin', windowFocused: false };
  assert.equal(shouldNotify(evenement, contexte), true, 'notifiée par défaut');
  assert.equal(
    shouldNotify(evenement, { ...contexte, settings: { ...DEFAULT_DESKTOP_NOTIFY, tasks: false } }),
    false,
  );
  assert.equal(
    shouldNotify(
      { ...evenement, source: 'register' },
      { ...contexte, settings: { ...DEFAULT_DESKTOP_NOTIFY, tasks: false } },
    ),
    true,
    'couper les tâches ne coupe pas les cahiers',
  );
});

/* ------------------------------------------------------------------ */
/* Rattachement au client et attribution                                */
/* ------------------------------------------------------------------ */

test('la tâche se rattache à une fiche client, ou garde juste un nom noté', () => {
  dataStore.mutate((db) => {
    db.clients.push({
      id: 'cli_snsm',
      code: 'CLI-0001',
      name: 'SNSM LE CROISIC',
      address: { label: '' },
      tags: [],
      aliases: [],
      archived: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  const avecFiche = upsertTask({ title: 'Livrer les cornets', clientId: 'cli_snsm' });
  assert.equal(avecFiche.clientId, 'cli_snsm');
  assert.equal(avecFiche.clientName, undefined, 'la fiche fait foi, pas un nom recopié');

  const sansFiche = upsertTask({ title: 'Rappeler le passant du marché', clientName: 'M. Morel' });
  assert.equal(sansFiche.clientId, undefined);
  assert.equal(sansFiche.clientName, 'M. Morel');

  const detachee = upsertTask({ id: avecFiche.id, clientId: '' });
  assert.equal(detachee.clientId, undefined);
  assert.match(detachee.history[0].text, /détachée du client/);

  purgeAfterTrash(avecFiche.id);
  purgeAfterTrash(sansFiche.id);
  dataStore.mutate((db) => {
    db.clients = db.clients.filter((c) => c.id !== 'cli_snsm');
  });
});

test('la liste des personnes ne montre que les comptes actifs, sans rien de sensible', () => {
  dataStore.mutate((db) => {
    db.users.push(
      {
        id: 'usr_a', username: 'herve', displayName: 'Hervé', role: 'bureau',
        passwordHash: 'sel:empreinte', createdAt: '', updatedAt: '',
      },
      {
        id: 'usr_b', username: 'ancien', displayName: 'Ancien salarié', role: 'livreur',
        passwordHash: 'sel:empreinte', disabled: true, createdAt: '', updatedAt: '',
      },
    );
  });
  const gens = listTaskPeople();
  assert.deepEqual(gens, [{ id: 'usr_a', displayName: 'Hervé' }]);
  assert.ok(!('passwordHash' in (gens[0] ?? {})), 'jamais d’empreinte de mot de passe');
  dataStore.mutate((db) => {
    db.users = db.users.filter((u) => !['usr_a', 'usr_b'].includes(u.id));
  });
});
