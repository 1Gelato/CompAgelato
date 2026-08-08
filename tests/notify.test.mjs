import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldNotify,
  SeenActivity,
  SOURCE_PAGE,
  DEFAULT_DESKTOP_NOTIFY,
  announce,
  announceImported,
  setActivityPublisher,
} from './build/services.mjs';

/**
 * Une notification qui répète ce que l'utilisateur vient de faire lui-même est
 * pire qu'aucune notification : au bout de trois, il les coupe, et c'est celle
 * qui comptait qu'il ratera. Ces tests portent donc surtout sur les cas où le
 * poste doit se taire.
 */

const MOI = 'usr_quentin';
const AUTRE = 'usr_herve';

function evenement(patch = {}) {
  return {
    source: 'register',
    title: 'SAV — CAMPING LES AJONCS',
    text: 'Machine en panne',
    by: AUTRE,
    at: '2026-08-08T09:30:00.000Z',
    ...patch,
  };
}

const enArrierePlan = { myUserId: MOI, windowFocused: false };

test('ce qu’un autre ajoute est notifié', () => {
  assert.equal(shouldNotify(evenement(), enArrierePlan), true);
});

test('ce que j’ajoute moi-même ne l’est jamais', () => {
  assert.equal(shouldNotify(evenement({ by: MOI }), enArrierePlan), false);
});

test('une arrivée sans auteur est notifiée', () => {
  // Un fichier déposé directement dans le dossier du serveur n'appartient à
  // personne — c'est précisément ce qu'on veut apprendre.
  assert.equal(shouldNotify(evenement({ by: null }), enArrierePlan), true);
});

test('sans identité connue, on ne se croit pas l’auteur de tout', () => {
  // Le poste n'a pas encore pu lire son identité (serveur lent au démarrage).
  // Écarter par défaut reviendrait à ne rien notifier du tout.
  assert.equal(shouldNotify(evenement(), { myUserId: null, windowFocused: false }), true);
});

test('chaque source se coupe séparément', () => {
  const sansCahiers = { ...DEFAULT_DESKTOP_NOTIFY, registers: false };
  assert.equal(shouldNotify(evenement(), { ...enArrierePlan, settings: sansCahiers }), false);
  assert.equal(
    shouldNotify(evenement({ source: 'document' }), { ...enArrierePlan, settings: sansCahiers }),
    true,
  );
  assert.equal(
    shouldNotify(evenement({ source: 'statement' }), { ...enArrierePlan, settings: sansCahiers }),
    true,
  );
});

test('fenêtre au premier plan : rien, sauf demande contraire', () => {
  const devantMoi = { myUserId: MOI, windowFocused: true };
  assert.equal(shouldNotify(evenement(), devantMoi), false);
  assert.equal(
    shouldNotify(evenement(), {
      ...devantMoi,
      settings: { ...DEFAULT_DESKTOP_NOTIFY, whenFocused: true },
    }),
    true,
  );
});

test('sans réglage enregistré, tout est notifié sauf devant l’écran', () => {
  // Le défaut doit être utile : une fonctionnalité qu'il faut activer pour
  // qu'elle serve ne sert à personne.
  assert.equal(shouldNotify(evenement(), { myUserId: MOI, windowFocused: false }), true);
  assert.equal(shouldNotify(evenement(), { myUserId: MOI, windowFocused: true }), false);
});

test('une même annonce n’est montrée qu’une fois', () => {
  // Le flux d'événements se rouvre après chaque coupure : sans cette mémoire,
  // une journée en zone blanche se solderait par une pluie de bulles.
  const vues = new SeenActivity();
  const e = evenement();
  assert.equal(vues.accept(e), true);
  assert.equal(vues.accept(e), false);
  assert.equal(vues.accept({ ...e, at: '2026-08-08T09:31:00.000Z' }), true);
});

test('la mémoire des annonces ne grandit pas sans fin', () => {
  const vues = new SeenActivity(3);
  const at = (n) => `2026-08-08T09:${String(n).padStart(2, '0')}:00.000Z`;
  for (let i = 0; i < 4; i++) assert.equal(vues.accept(evenement({ at: at(i) })), true);
  // La première est sortie de la mémoire : elle serait remontrée, ce qui est
  // le prix assumé d'une mémoire bornée.
  assert.equal(vues.accept(evenement({ at: at(0) })), true);
  assert.equal(vues.accept(evenement({ at: at(3) })), false);
});

test('chaque source ouvre la page qui la concerne', () => {
  assert.equal(SOURCE_PAGE.register, 'cahiers');
  assert.equal(SOURCE_PAGE.document, 'documents');
  assert.equal(SOURCE_PAGE.statement, 'banque');
});

/* ------------------------------------------------------------------ */
/* Ce que le serveur annonce                                            */
/* ------------------------------------------------------------------ */

test('hors requête, une annonce n’a pas d’auteur', () => {
  // C'est le cas de la surveillance du dossier serveur : personne n'a cliqué,
  // donc personne ne doit être écarté du filtre « sauf si c'est moi ».
  const vues = [];
  setActivityPublisher((e) => vues.push(e));
  try {
    const event = announce('document', 'Nouvelle pièce : FA-1', 'Client — 10,00 € TTC');
    assert.equal(event.by, null);
    assert.equal(vues.length, 1);
    assert.equal(vues[0].source, 'document');
  } finally {
    setActivityPublisher(() => {});
  }
});

test('un import massif ne fait qu’une annonce, pas trois cents', () => {
  const vues = [];
  setActivityPublisher((e) => vues.push(e));
  try {
    announceImported(
      Array.from({ length: 294 }, (_, i) => ({ number: `FA-${i}`, totalTTC: 10 })),
    );
    assert.equal(vues.length, 1);
    assert.match(vues[0].title, /294 nouvelles pièces/);
    // Les premiers numéros suffisent à savoir de quoi il s'agit.
    assert.match(vues[0].text, /FA-0, FA-1, FA-2, FA-3…/);
  } finally {
    setActivityPublisher(() => {});
  }
});

test('une seule pièce est nommée, avec son client et son montant', () => {
  const vues = [];
  setActivityPublisher((e) => vues.push(e));
  try {
    announceImported([{ number: 'BRO00001044', clientNameRaw: 'SNSM LE CROISIC', totalTTC: 736.38 }]);
    assert.equal(vues.length, 1);
    assert.equal(vues[0].title, 'Nouvelle pièce : BRO00001044');
    assert.equal(vues[0].text, 'SNSM LE CROISIC — 736,38 € TTC');
  } finally {
    setActivityPublisher(() => {});
  }
});

test('une relecture qui n’apporte rien de neuf n’annonce rien', () => {
  const vues = [];
  setActivityPublisher((e) => vues.push(e));
  try {
    announceImported([]);
    assert.equal(vues.length, 0);
  } finally {
    setActivityPublisher(() => {});
  }
});

test('une annonce ne fait jamais échouer ce qui l’a déclenchée', () => {
  setActivityPublisher(() => {
    throw new Error('flux coupé');
  });
  try {
    assert.doesNotThrow(() => announce('register', 'SAV', 'Machine en panne'));
  } finally {
    setActivityPublisher(() => {});
  }
});
