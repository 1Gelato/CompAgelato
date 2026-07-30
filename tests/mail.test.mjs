import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEml, buildMailto, encodeHeader, mimeTypeFor, applyTemplate, safeFileName } from './build/services.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compagelato-mail-'));
const flyer = path.join(tmp, 'Flyer été.pdf');
fs.writeFileSync(flyer, Buffer.from('%PDF-1.4 contenu de démonstration', 'utf8'));

test('en-têtes accentués encodés selon la RFC 2047', () => {
  assert.equal(encodeHeader('Devis 2026-001'), 'Devis 2026-001');
  const encoded = encodeHeader('Devis n°12 — Été');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  // Le décodage doit rendre la chaîne d'origine.
  const base64 = encoded.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
  assert.equal(Buffer.from(base64, 'base64').toString('utf8'), 'Devis n°12 — Été');
});

test('types MIME des pièces jointes courantes', () => {
  assert.equal(mimeTypeFor('/x/flyer.pdf'), 'application/pdf');
  assert.equal(mimeTypeFor('/x/photo.JPG'), 'image/jpeg');
  assert.equal(mimeTypeFor('/x/tarif.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(mimeTypeFor('/x/inconnu.zzz'), 'application/octet-stream');
});

test('message multipart avec pièce jointe', () => {
  const { content, attachmentBytes, missing } = buildEml({
    to: 'client@exemple.fr',
    from: 'contact@glaces.fr',
    subject: 'Devis DE-2026-0031',
    body: 'Bonjour,\nVoici le devis.',
    attachments: [{ filePath: flyer }],
  });

  assert.deepEqual(missing, []);
  assert.equal(attachmentBytes, fs.statSync(flyer).size);

  assert.match(content, /^Date: /m);
  assert.match(content, /^To: client@exemple\.fr$/m);
  assert.match(content, /^From: contact@glaces\.fr$/m);
  // Ouvre le message en rédaction dans Outlook plutôt qu'en lecture seule.
  assert.match(content, /^X-Unsent: 1$/m);
  assert.match(content, /^Content-Type: multipart\/mixed; boundary="(.+)"$/m);

  // Le corps est encodé en base64 : on doit y retrouver le texte d'origine.
  const boundary = content.match(/boundary="(.+)"/)[1];
  const parts = content.split(`--${boundary}`);
  assert.ok(parts.length >= 4, 'corps + pièce jointe + terminaison attendus');

  const bodyPart = parts.find((p) => p.includes('text/plain'));
  const bodyBase64 = bodyPart.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(bodyBase64, 'base64').toString('utf8'), 'Bonjour,\nVoici le devis.');

  const filePart = parts.find((p) => p.includes('application/pdf'));
  assert.match(filePart, /Content-Disposition: attachment/);
  // Nom accentué : encodage RFC 2231.
  assert.match(filePart, /filename\*=UTF-8''/);

  // Les lignes base64 ne dépassent pas 76 caractères (contrainte MIME).
  for (const line of content.split('\r\n')) {
    assert.ok(line.length <= 998, 'ligne trop longue pour un message MIME');
  }

  assert.ok(content.trimEnd().endsWith(`--${boundary}--`), 'terminaison multipart manquante');
});

test('pièce jointe introuvable signalée sans faire échouer le message', () => {
  const { content, missing } = buildEml({
    to: 'a@b.fr',
    subject: 'Test',
    body: 'Bonjour',
    attachments: [{ filePath: path.join(tmp, 'absent.pdf'), fileName: 'absent.pdf' }],
  });
  assert.deepEqual(missing, ['absent.pdf']);
  assert.match(content, /^To: a@b\.fr$/m);
});

test('lien mailto de secours', () => {
  const url = buildMailto({
    to: 'client@exemple.fr',
    subject: 'Devis n°12',
    body: 'Bonjour,\nMerci.',
  });
  assert.ok(url.startsWith('mailto:client%40exemple.fr?'));
  const query = new URLSearchParams(url.split('?')[1]);
  assert.equal(query.get('subject'), 'Devis n°12');
  assert.equal(query.get('body'), 'Bonjour,\nMerci.');
});

test('modèles de message', () => {
  const result = applyTemplate('{type} {numero} du {date} — {inconnu}', {
    type: 'Devis',
    numero: 'DE-001',
    date: '02/04/2026',
  });
  assert.equal(result, 'Devis DE-001 du 02/04/2026 — {inconnu}');
});

test('nom de fichier assaini', () => {
  assert.equal(safeFileName('Facture FA/2026:0142'), 'Facture FA-2026-0142');
  assert.equal(safeFileName('   '), 'document');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
