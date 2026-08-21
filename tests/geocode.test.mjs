import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dataStore,
  addressQuery,
  addressQueries,
  geocodeStatus,
  startGeocode,
  waitGeocode,
} from './build/services.mjs';

/**
 * La géolocalisation travaillait dans la requête : sept cents adresses à la
 * file, la réponse n'arrivait jamais avant l'expiration du délai, et le poste
 * se croyait hors ligne. Elle vit désormais en tâche de fond — ce fichier fige
 * le contrat : lancement immédiat, avancement consultable, jamais deux passes
 * à la fois, et les coordonnées réellement écrites.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-geocode-'));

function fiche(id, name, address) {
  return {
    id,
    code: id.toUpperCase(),
    name,
    address,
    tags: [],
    aliases: [],
    archived: false,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  };
}

test.before(() => {
  dataStore.init({
    dataDir: path.join(dir, 'donnees'),
    documentsDir: path.join(dir, 'Documents'),
  });
  dataStore.mutate((db) => {
    db.clients.push(
      // Décomposée : la requête au géocodeur suit rue + CP + ville.
      fiche('cli_a', 'ACCOORD', {
        label: "10 RUE D'ERLON, 44000 Nantes",
        street: "10 RUE D'ERLON",
        postcode: '44000',
        city: 'Nantes',
      }),
      // Introuvable pour le géocodeur : comptée en échec, jamais bloquante.
      fiche('cli_b', 'MYSTERE', { label: 'adresse illisible' }),
      // Déjà localisée : rien à faire.
      fiche('cli_c', 'DEJA LA', { label: 'x', lat: 47.2, lon: -1.5 }),
      // Archivée : on ne géocode pas les fiches sorties du carnet.
      fiche('cli_d', 'ARCHIVE', { label: '1 rue Haute 44880 Sautron' }),
    );
    db.clients.find((c) => c.id === 'cli_d').archived = true;
  });
});

test.after(() => {
  dataStore.flushSync();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('la requête au géocodeur préfère les morceaux décomposés', () => {
  const client = dataStore.db.clients.find((c) => c.id === 'cli_a');
  assert.equal(addressQuery(client), "10 RUE D'ERLON 44000 Nantes");
  const brut = dataStore.db.clients.find((c) => c.id === 'cli_b');
  assert.equal(addressQuery(brut), 'adresse illisible');
});

test('la passe répond tout de suite, travaille en fond, et écrit les coordonnées', async () => {
  const interroge = [];
  const fake = async (query) => {
    interroge.push(query);
    if (query.includes('illisible')) return null;
    return { label: `${query} (géocodée)`, postcode: '44000', city: 'Nantes', lat: 47.21, lon: -1.55, score: 0.9 };
  };

  const depart = startGeocode({ geocode: fake, delayMs: 0 });
  // La réponse est immédiate : c'est tout l'objet de la tâche de fond.
  assert.equal(depart.total, 2, 'cli_a et cli_b seulement — ni la localisée, ni l’archivée');

  // Relancer pendant la passe ne déclenche pas un second travail.
  const relance = startGeocode({ geocode: fake, delayMs: 0 });
  assert.equal(relance.total, 2);

  await waitGeocode();
  const fin = geocodeStatus();
  assert.equal(fin.running, false);
  assert.equal(fin.processed, 2);
  assert.equal(fin.located, 1);
  assert.equal(fin.failed, 1);
  assert.ok(fin.finishedAt, 'la fin est datée');
  assert.equal(interroge.length, 2, 'chaque fiche interrogée une seule fois');

  const client = dataStore.db.clients.find((c) => c.id === 'cli_a');
  assert.equal(client.address.lat, 47.21);
  assert.equal(client.address.lon, -1.55);
  // Le libellé déjà saisi n'est pas écrasé par celui du géocodeur.
  assert.equal(client.address.label, "10 RUE D'ERLON, 44000 Nantes");
});

test('une nouvelle passe ne reprend que ce qui reste sans coordonnées', async () => {
  const interroge = [];
  const fake = async (query) => {
    interroge.push(query);
    return null;
  };
  const depart = startGeocode({ geocode: fake, delayMs: 0 });
  // cli_a est localisée depuis la passe précédente : seul l'échec restant repasse.
  assert.equal(depart.total, 1);
  await waitGeocode();
  assert.deepEqual(interroge, ['adresse illisible']);
});

test('rien à faire : la passe le dit sans se lancer', () => {
  dataStore.mutate((db) => {
    for (const client of db.clients) {
      if (typeof client.address.lat !== 'number') {
        client.address.lat = 47;
        client.address.lon = -1.5;
      }
    }
  });
  const status = startGeocode({ geocode: async () => null, delayMs: 0 });
  assert.equal(status.total, 0);
  assert.equal(status.running, false);
});

/* ------------------------------------------------------------------ */
/* Les adresses que le service public ne reconnaissait jamais            */
/* ------------------------------------------------------------------ */

test('la question est nettoyée, puis se replie sur la commune', () => {
  // Telles qu'elles arrivent des listes importées : un e-mail, un téléphone
  // ou un prénom collés dans la rue.
  const sale = fiche('cli_e', 'A TON AISE', {
    label: '158 RUE DE BELGIQUE atonaise56@gmail.com JULIEN 56100 LORIENT',
    street: '158 RUE DE BELGIQUE atonaise56@gmail.com JULIEN',
    postcode: '56100',
    city: 'LORIENT',
  });

  const attempts = addressQueries(sale);
  // L'e-mail part ; le prénom, lui, reste — rien ne permet de le distinguer
  // d'un nom de rue à coup sûr. C'est précisément pourquoi le repli existe.
  assert.equal(attempts[0], '158 RUE DE BELGIQUE JULIEN 56100 LORIENT');
  assert.ok(!attempts.some((q) => q.includes('@')), 'aucune question ne porte l’e-mail');
  assert.equal(
    attempts[attempts.length - 1],
    '56100 LORIENT',
    'dernier recours : la commune seule',
  );
  // La première tentative reste celle que renvoie addressQuery.
  assert.equal(addressQuery(sale), attempts[0]);
});

test('une rue introuvable ne condamne plus la fiche : la commune la sauve', async () => {
  dataStore.mutate((db) => {
    db.clients.push(
      fiche('cli_f', 'ABBAYE DE VILLENEUVE', {
        label: 'M DAVID FERRE 0683308109 ABBAYE DE VILLENEUVE 44840 Les Sorinières',
        street: 'M DAVID FERRE 0683308109 ABBAYE DE VILLENEUVE',
        postcode: '44840',
        city: 'Les Sorinières',
      }),
    );
  });

  const interroge = [];
  const fake = async (query) => {
    interroge.push(query);
    // Le service ne reconnaît que la commune : c'est le cas réel de ces
    // adresses où le nom du contact tient lieu de rue.
    if (query !== '44840 Les Sorinières') return null;
    return { label: 'Les Sorinières', postcode: '44840', city: 'Les Sorinières', lat: 47.14, lon: -1.53, score: 0.6 };
  };

  const depart = startGeocode({ geocode: fake, delayMs: 0 });
  assert.equal(depart.total, 1);
  await waitGeocode();

  const fin = geocodeStatus();
  assert.equal(fin.located, 1, `tentatives : ${JSON.stringify(interroge)}`);
  assert.equal(fin.failed, 0);
  assert.ok(interroge.length > 1, 'la première question, trop précise, a bien été retentée');

  const client = dataStore.db.clients.find((c) => c.id === 'cli_f');
  assert.equal(client.address.lat, 47.14);
  // Le point tombe au centre de la commune : suffisant pour entrer dans une
  // tournée, ce qu'une fiche sans coordonnées ne pouvait pas faire.
  assert.equal(client.address.lon, -1.53);
});
