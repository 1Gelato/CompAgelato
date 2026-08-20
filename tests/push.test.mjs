import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  dataStore,
  withContext,
  signAssertion,
  accessToken,
  sendPush,
  configureFcm,
  fcmEnabled,
  readServiceAccount,
  registerDevice,
  unregisterDevice,
  listDevices,
  recipientsFor,
  pushActivityToDevices,
  forgetDevicesOfSession,
  forgetDevicesOfUser,
} from './build/services.mjs';

/**
 * Les notifications natives touchent deux choses délicates : une signature
 * cryptographique que Google doit accepter, et le tri de qui a le droit de
 * recevoir quoi. Les deux se vérifient ici sans réseau — la clé est fabriquée
 * dans le test, et `fetch` est remplacé.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-push-'));

/** Une vraie paire RSA : la signature produite est vérifiable pour de bon. */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const COMPTE = {
  projectId: 'compagelato-test',
  clientEmail: 'robot@compagelato-test.iam.gserviceaccount.com',
  privateKey,
  tokenUri: 'https://oauth2.googleapis.com/token',
};

const GERANT = { userId: 'usr_quentin', username: 'quentin', displayName: 'Quentin', role: 'gerant' };
const LIVREUR = { userId: 'usr_herve', username: 'herve', displayName: 'Hervé', role: 'livreur' };

function enTantQue(identity, run) {
  return withContext({ identity, role: identity.role, token: '', from: 'test' }, run);
}

test.before(() => {
  dataStore.init({
    dataDir: path.join(dir, 'donnees'),
    documentsDir: path.join(dir, 'Documents'),
  });
  dataStore.mutate((db) => {
    db.users.push(
      { ...GERANT, id: GERANT.userId, passwordHash: 'sel:empreinte', createdAt: '', updatedAt: '' },
      { ...LIVREUR, id: LIVREUR.userId, passwordHash: 'sel:empreinte', createdAt: '', updatedAt: '' },
    );
  });
});

test.after(() => {
  configureFcm(null);
  dataStore.flushSync();
  fs.rmSync(dir, { recursive: true, force: true });
});

function reset() {
  dataStore.mutate((db) => {
    db.pushDevices = [];
  });
}

/* ------------------------------------------------------------------ */
/* La signature que Google doit accepter                                */
/* ------------------------------------------------------------------ */

function decode(part) {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

test('l’assertion JWT est signée pour de vrai et porte les bonnes prétentions', () => {
  const jwt = signAssertion(COMPTE, 1_700_000_000);
  const [header, claims, signature] = jwt.split('.');

  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  const payload = decode(claims);
  assert.equal(payload.iss, COMPTE.clientEmail);
  assert.equal(payload.aud, COMPTE.tokenUri);
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(payload.iat, 1_700_000_000);
  assert.equal(payload.exp, 1_700_003_600, 'une heure de validité');

  // La vérification cryptographique : c'est elle qui dit si Google acceptera.
  const ok = crypto
    .createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(publicKey, Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  assert.equal(ok, true, 'signature invalide : Google refuserait le jeton');
});

test('le jeton d’accès est mis en cache, puis renouvelé avant d’expirer', async () => {
  configureFcm(COMPTE);
  let appels = 0;
  const faux = async () => {
    appels++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: `jeton-${appels}`, expires_in: 3600 }),
      text: async () => '',
    };
  };

  const t0 = 1_700_000_000;
  assert.equal(await accessToken({ fetch: faux, now: () => t0 }), 'jeton-1');
  // Dix minutes plus tard : le jeton précédent vaut encore, aucun appel de plus.
  assert.equal(await accessToken({ fetch: faux, now: () => t0 + 600 }), 'jeton-1');
  assert.equal(appels, 1, 'Google interrogé une seule fois');

  // À cinq minutes de l'expiration, on renouvelle sans attendre le refus.
  assert.equal(await accessToken({ fetch: faux, now: () => t0 + 3400 }), 'jeton-2');
  assert.equal(appels, 2);
  configureFcm(null);
});

test('sans clé configurée, rien n’est envoyé et rien ne casse', async () => {
  configureFcm(null);
  assert.equal(fcmEnabled(), false);
  let appels = 0;
  const outcome = await sendPush('jeton-appareil', { title: 'A', body: 'B' }, {
    fetch: async () => {
      appels++;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    },
  });
  assert.equal(outcome, 'failed');
  assert.equal(appels, 0, 'aucun appel réseau sans clé');
});

test('une clé illisible ne fait pas tomber le serveur, elle désactive le push', () => {
  assert.equal(readServiceAccount(undefined), null);
  assert.equal(readServiceAccount(path.join(dir, 'absent.json')), null);
  const bancal = path.join(dir, 'bancal.json');
  fs.writeFileSync(bancal, JSON.stringify({ project_id: 'x' })); // sans clé privée
  assert.equal(readServiceAccount(bancal), null);
});

test('un appareil que Firebase ne connaît plus est signalé « disparu »', async () => {
  configureFcm(COMPTE);
  const jeton = async (url) =>
    String(url).includes('oauth2')
      ? { ok: true, status: 200, json: async () => ({ access_token: 'j', expires_in: 3600 }), text: async () => '' }
      : {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}',
        };
  const outcome = await sendPush('vieux-jeton', { title: 'A', body: 'B' }, {
    fetch: jeton,
    now: () => 1_700_000_000,
  });
  assert.equal(outcome, 'gone');
  configureFcm(null);
});

/* ------------------------------------------------------------------ */
/* Qui reçoit quoi                                                     */
/* ------------------------------------------------------------------ */

test('l’auteur d’un geste n’est jamais notifié sur son propre téléphone', () => {
  reset();
  enTantQue(GERANT, () => registerDevice({ token: 'tel-quentin', label: 'Pixel de Quentin' }));
  enTantQue(LIVREUR, () => registerDevice({ token: 'tel-herve', label: 'Redmi d’Hervé' }));

  const annonce = {
    source: 'register',
    title: 'SAV — CAMPING LES AJONCS',
    text: 'Machine en panne',
    by: GERANT.userId,
    at: '2026-08-20T09:00:00.000Z',
  };
  // Le cahier SAV est refusé au livreur : il ne reste donc personne.
  assert.deepEqual(recipientsFor(annonce).map((d) => d.token), []);

  // Sans auteur (fichier déposé sur le serveur), le gérant est prévenu.
  const sansAuteur = { ...annonce, by: null };
  assert.deepEqual(recipientsFor(sansAuteur).map((d) => d.token), ['tel-quentin']);
});

test('le téléphone d’un livreur ne reçoit pas ce que son rôle lui interdit', () => {
  reset();
  enTantQue(LIVREUR, () => registerDevice({ token: 'tel-herve' }));

  // Masquer un écran tout en criant son contenu dans la barre de
  // notifications serait une passoire : le filtre est le même que celui des
  // écrans et du miroir.
  for (const source of ['document', 'statement', 'task', 'register']) {
    const cibles = recipientsFor({ source, title: 'X', text: 'Y', by: null, at: '' });
    assert.deepEqual(cibles, [], `le livreur ne doit rien recevoir de « ${source} »`);
  }
});

test('un compte désactivé cesse d’être prévenu', () => {
  reset();
  enTantQue(GERANT, () => registerDevice({ token: 'tel-quentin' }));
  dataStore.mutate((db) => {
    db.users.find((u) => u.id === GERANT.userId).disabled = true;
  });
  assert.deepEqual(recipientsFor({ source: 'task', title: 'X', text: 'Y', by: null, at: '' }), []);
  dataStore.mutate((db) => {
    db.users.find((u) => u.id === GERANT.userId).disabled = false;
  });
});

/* ------------------------------------------------------------------ */
/* Le registre                                                         */
/* ------------------------------------------------------------------ */

test('rouvrir l’application ne crée pas un second abonnement', () => {
  reset();
  enTantQue(GERANT, () => registerDevice({ token: 'tel-quentin', label: 'Pixel' }));
  enTantQue(GERANT, () => registerDevice({ token: 'tel-quentin', label: 'Pixel 7' }));
  const devices = listDevices();
  assert.equal(devices.length, 1, 'le jeton fait l’identité de l’appareil');
  assert.equal(devices[0].label, 'Pixel 7', 'l’étiquette se met à jour');
  assert.equal(devices[0].username, 'quentin');
});

test('un téléphone qui change de main change de propriétaire', () => {
  reset();
  enTantQue(GERANT, () => registerDevice({ token: 'tel-partage' }));
  enTantQue(LIVREUR, () => registerDevice({ token: 'tel-partage' }));
  const devices = listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].userId, LIVREUR.userId, 'l’ancien propriétaire ne reçoit plus rien');
});

test('sans session ouverte, on n’abonne rien', () => {
  reset();
  assert.throws(() => registerDevice({ token: 'anonyme' }), /session/i);
});

test('révoquer une session ou supprimer un compte fait taire le téléphone', () => {
  reset();
  enTantQue(GERANT, () => registerDevice({ token: 'tel-session', sessionId: 'ses_1' }));
  forgetDevicesOfSession('ses_1');
  assert.equal(listDevices().length, 0);

  enTantQue(LIVREUR, () => registerDevice({ token: 'tel-herve' }));
  forgetDevicesOfUser(LIVREUR.userId);
  assert.equal(listDevices().length, 0);

  enTantQue(GERANT, () => registerDevice({ token: 'tel-quentin' }));
  unregisterDevice('tel-quentin');
  assert.equal(listDevices().length, 0);
});

/** `fetch` de substitution : le jeton passe, l'envoi répond ce qu'on veut. */
function fauxReseau(reponseEnvoi) {
  return async (url) =>
    String(url).includes('oauth2')
      ? {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'j', expires_in: 3600 }),
          text: async () => '',
        }
      : reponseEnvoi;
}

const OK_ENVOI = { ok: true, status: 200, json: async () => ({}), text: async () => '' };
const APPAREIL_DISPARU = {
  ok: false,
  status: 404,
  json: async () => ({}),
  text: async () => '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}',
};
const PANNE = { ok: false, status: 503, json: async () => ({}), text: async () => 'indisponible' };

test('un appareil désinstallé est retiré du registre à la première annonce', async () => {
  reset();
  configureFcm(COMPTE);
  enTantQue(GERANT, () => registerDevice({ token: 'tel-desinstalle' }));

  await pushActivityToDevices(
    { source: 'task', title: 'Nouvelle tâche', text: 'Relancer le camping', by: null, at: '' },
    { fetch: fauxReseau(APPAREIL_DISPARU), now: () => 1_700_000_000 },
  );
  assert.equal(listDevices().length, 0, 'sinon le registre se remplit de fantômes');
  configureFcm(null);
});

test('une panne du serveur de Google n’efface jamais un abonnement', async () => {
  reset();
  configureFcm(COMPTE);
  enTantQue(GERANT, () => registerDevice({ token: 'tel-quentin' }));

  await pushActivityToDevices(
    { source: 'task', title: 'Nouvelle tâche', text: 'X', by: null, at: '' },
    { fetch: fauxReseau(PANNE), now: () => 1_700_000_000 },
  );
  assert.equal(listDevices().length, 1, 'une panne passagère n’est pas une désinstallation');
  configureFcm(null);
});

test('une annonce part bien vers le téléphone concerné', async () => {
  reset();
  configureFcm(COMPTE);
  enTantQue(GERANT, () => registerDevice({ token: 'tel-quentin' }));

  const envois = [];
  const espion = async (url, options) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'j', expires_in: 3600 }), text: async () => '' };
    }
    envois.push(JSON.parse(options.body).message);
    return OK_ENVOI;
  };

  await pushActivityToDevices(
    { source: 'task', title: 'Nouvelle tâche — Rappeler', text: 'priorité urgente', by: null, at: '' },
    { fetch: espion, now: () => 1_700_000_000 },
  );

  assert.equal(envois.length, 1);
  assert.equal(envois[0].token, 'tel-quentin');
  assert.equal(envois[0].notification.title, 'Nouvelle tâche — Rappeler');
  assert.equal(envois[0].notification.body, 'priorité urgente');
  // Le clic doit ouvrir l'onglet Tâches : c'est ce que transporte `data`.
  assert.deepEqual(envois[0].data, { source: 'task', page: 'taches' });
  // Sans canal déclaré, Android range la notification en importance minimale.
  assert.equal(envois[0].android.notification.channel_id, 'compagelato');
  assert.equal(envois[0].android.priority, 'high');
  assert.equal(listDevices().length, 1);
  configureFcm(null);
});
