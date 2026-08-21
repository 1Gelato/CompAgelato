import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPdf,
  parsePdfDocument,
  detectDraft,
  detectKindDetailed,
  parseEInvoiceXml,
  extractClient,
  isWatermarkItem,
  looksLikeClientName,
  matchClient,
  rememberClientAlias,
  extractLinesFromPdf,
  looksLikeVatRecapRow,
} from './build/services.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pdfDir = path.join(here, 'fixtures', 'pdf');

test('facture PDF : en-tête, client, totaux et lignes', async () => {
  const file = path.join(pdfDir, 'FA-2026-0142.pdf');
  const extract = await extractPdf(file);
  const doc = parsePdfDocument(extract, file);

  assert.equal(doc.kind, 'invoice');
  assert.equal(doc.number, 'FA-2026-0142');
  assert.equal(doc.date, '2026-03-14');
  assert.equal(doc.dueDate, '2026-04-13');
  assert.match(doc.clientName, /COMPTOIR DES GLACES/i);
  assert.equal(doc.totalHT, 319);
  assert.equal(doc.totalVAT, 63.8);
  assert.equal(doc.totalTTC, 382.8);

  assert.equal(doc.lines.length, 4);
  const first = doc.lines[0];
  assert.equal(first.ref, 'CUP-100');
  assert.match(first.label, /Coupelle carton 100 ml/);
  assert.equal(first.qty, 12);
  assert.equal(first.unit, 'carton');
  assert.equal(first.unitPriceHT, 8.9);
  assert.equal(first.totalHT, 106.8);

  const sum = doc.lines.reduce((s, l) => s + l.totalHT, 0);
  assert.ok(Math.abs(sum - doc.totalHT) < 0.01, `somme des lignes ${sum} ≠ ${doc.totalHT}`);
  assert.ok(doc.confidence > 0.8, `confiance trop basse : ${doc.confidence}`);
});

test('deuxième facture PDF', async () => {
  const file = path.join(pdfDir, 'FA-2026-0143.pdf');
  const doc = parsePdfDocument(await extractPdf(file), file);
  assert.equal(doc.number, 'FA-2026-0143');
  assert.equal(doc.totalHT, 143.7);
  assert.equal(doc.totalTTC, 172.44);
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.lines[1].qty, 8);
  assert.equal(doc.lines[1].unitPriceHT, 12.4);
});

test('devis PDF avec date en toutes lettres', async () => {
  const file = path.join(pdfDir, 'DE-2026-0031.pdf');
  const doc = parsePdfDocument(await extractPdf(file), file);
  assert.equal(doc.kind, 'quote');
  assert.equal(doc.number, 'DE-2026-0031');
  assert.equal(doc.date, '2026-04-02');
  assert.equal(doc.totalHT, 1028);
  assert.equal(doc.lines.length, 2);
  assert.match(doc.clientName, /Pornichet/i);
});

test('Factur-X (CII) : lecture structurée', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocument>
    <ram:ID>FA-2026-0150</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20260405</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:SpecifiedTradeProduct>
        <ram:SellerAssignedID>CUP-100</ram:SellerAssignedID>
        <ram:Name>Coupelle carton 100 ml (x50)</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>8.90</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="BX">10</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:RateApplicablePercent>20</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>89.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty><ram:Name>GLACES DU LITTORAL</ram:Name></ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>LE COMPTOIR DES GLACES SARL</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>44500</ram:PostcodeCode>
          <ram:LineOne>8 avenue de la Plage</ram:LineOne>
          <ram:CityName>La Baule</ram:CityName>
        </ram:PostalTradeAddress>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime><udt:DateTimeString format="102">20260505</udt:DateTimeString></ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>89.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>89.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">17.80</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>106.80</ram:GrandTotalAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

  const doc = parseEInvoiceXml(xml);
  assert.ok(doc, 'document non analysé');
  assert.equal(doc.kind, 'invoice');
  assert.equal(doc.number, 'FA-2026-0150');
  assert.equal(doc.date, '2026-04-05');
  assert.equal(doc.dueDate, '2026-05-05');
  assert.equal(doc.clientName, 'LE COMPTOIR DES GLACES SARL');
  assert.equal(doc.clientAddress, '8 avenue de la Plage, 44500 La Baule');
  assert.equal(doc.totalHT, 89);
  assert.equal(doc.totalVAT, 17.8);
  assert.equal(doc.totalTTC, 106.8);
  assert.equal(doc.lines.length, 1);
  assert.equal(doc.lines[0].ref, 'CUP-100');
  assert.equal(doc.lines[0].qty, 10);
  assert.equal(doc.lines[0].unit, 'carton');
  assert.equal(doc.lines[0].vatRate, 20);
});

test('UBL 2.1 : lecture structurée', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>F-2026-77</cbc:ID>
  <cbc:IssueDate>2026-05-12</cbc:IssueDate>
  <cbc:DueDate>2026-06-11</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Restaurant La Dune</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>3 boulevard Ocean</cbc:StreetName>
        <cbc:CityName>Piriac-sur-Mer</cbc:CityName>
        <cbc:PostalZone>44420</cbc:PostalZone>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">24.80</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">124.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">124.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">148.80</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">148.80</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">10</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">124.00</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>Cornet gaufre standard</cbc:Name>
      <cac:SellersItemIdentification><cbc:ID>CON-STD</cbc:ID></cac:SellersItemIdentification>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">12.40</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

  const doc = parseEInvoiceXml(xml);
  assert.ok(doc);
  assert.equal(doc.number, 'F-2026-77');
  assert.equal(doc.date, '2026-05-12');
  assert.equal(doc.clientName, 'Restaurant La Dune');
  assert.equal(doc.totalHT, 124);
  assert.equal(doc.totalVAT, 24.8);
  assert.equal(doc.totalTTC, 148.8);
  assert.equal(doc.lines[0].ref, 'CON-STD');
  assert.equal(doc.lines[0].qty, 10);
  assert.equal(doc.lines[0].unitPriceHT, 12.4);
});

test('gabarit à deux colonnes (vendeur/client sur les mêmes lignes) : nom, adresse et totaux corrects', async () => {
  const file = path.join(pdfDir, 'FA-2026-DEUXCOL.pdf');
  const doc = parsePdfDocument(await extractPdf(file), file);

  // Le nom du client ne doit pas être confondu avec la ligne « Siret : ... N° client : ... »
  // qui mélange les colonnes vendeur et client sur la même ligne visuelle.
  assert.equal(doc.clientName, 'LES GLACES DU PORT');
  assert.equal(doc.clientAddress, '12 QUAI DU COMMERCE, 56100 LORIENT');

  // L'e-mail du client (dernière ligne du bloc, sans fusion de colonne) doit être
  // capturé sans être confondu avec l'e-mail du vendeur fusionné plus haut.
  assert.equal(doc.clientEmail, 'contact@glacesduport.fr');

  // « Base HT » apparaît comme un en-tête de tableau récapitulatif (« Code | Base HT |
  // Taux | Montant ») et ne doit pas écraser le vrai Total HT lu plus haut.
  assert.equal(doc.totalHT, 96.3);
  assert.equal(doc.totalVAT, 19.26);
  assert.equal(doc.totalTTC, 115.56);

  // Le tableau récapitulatif de TVA et les mentions bancaires en bas de page ne
  // doivent pas être lus comme des lignes de produits supplémentaires.
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.lines[0].totalHT, 90);
  assert.equal(doc.lines[1].totalHT, 6.3);

  const sum = doc.lines.reduce((s, l) => s + l.totalHT, 0);
  assert.ok(Math.abs(sum - doc.totalHT) < 0.01, `somme des lignes ${sum} ≠ total HT ${doc.totalHT}`);
  assert.equal(doc.warnings.length, 0, JSON.stringify(doc.warnings));
  assert.equal(doc.confidence, 1);
});

test('facture sur deux pages : les articles de la page 2 sont lus, pas l’en-tête réimprimé', async () => {
  const file = path.join(pdfDir, 'FA-2026-2PAGES.pdf');
  const doc = parsePdfDocument(await extractPdf(file), file);

  // Le tableau continue page 2 : les trois articles doivent être présents, et
  // seulement eux. Le bloc vendeur réimprimé en haut de page 2 (adresse, « N° »,
  // « Date : 03/07/2026 ») ne doit produire aucune ligne fantôme — c'est la date
  // lue comme un montant qui gonflait le total à plus de trois millions d'euros.
  assert.equal(doc.lines.length, 3);
  assert.deepEqual(
    doc.lines.map((l) => l.label),
    ['Mix vanille poche 4,5 kg', 'Mix fraise poche 4,5 kg', 'Cornets x120'],
  );
  assert.equal(doc.lines[2].qty, 3);
  assert.equal(doc.lines[2].unitPriceHT, 49);
  assert.equal(doc.lines[2].totalHT, 147);

  // Le pied de page légal et le total, répétés en bas de *chaque* page, ne
  // doivent pas arrêter la lecture avant la fin du tableau.
  assert.equal(doc.totalHT, 669);
  assert.equal(doc.totalTTC, 705.8);
  const sum = doc.lines.reduce((s, l) => s + l.totalHT, 0);
  assert.ok(Math.abs(sum - doc.totalHT) < 0.01, `somme des lignes ${sum} ≠ total HT ${doc.totalHT}`);

  // Le bloc client n'est imprimé que page 1 : il doit tout de même être lu.
  assert.equal(doc.clientName, 'GLACIER DE LA PLAGE');
  assert.equal(doc.warnings.length, 0, JSON.stringify(doc.warnings));
  assert.equal(doc.confidence, 1);
});

test('facture brouillon : le filigrane ne pollue ni le texte, ni les lignes, ni les totaux', async () => {
  const file = path.join(pdfDir, 'FA-2026-FILIGRANE.pdf');
  const extract = await extractPdf(file);

  // « BROUILLON » est imprimé en diagonale par-dessus le tableau et
  // « DUPLICATA » en gros à l'horizontale : aucun des deux n'est une donnée.
  assert.ok(!extract.text.includes('BROUILLON'), extract.text);
  assert.ok(!extract.text.includes('DUPLICATA'), extract.text);

  const doc = parsePdfDocument(extract, file);
  assert.equal(doc.number, 'FA-2026-0301');
  assert.equal(doc.lines.length, 2);
  assert.deepEqual(
    doc.lines.map((l) => l.label),
    ['Mix vanille poche 4,5 kg', 'Gobelet carton 120 ml (x100)'],
  );
  assert.equal(doc.totalHT, 125.8);
  assert.equal(doc.totalTTC, 132.72);
  assert.equal(doc.clientName, 'GLACIER DE LA PLAGE');
  assert.equal(doc.warnings.length, 0, JSON.stringify(doc.warnings));
  assert.equal(doc.confidence, 1);
});

test('le tri filigrane / donnée reste étroit : seul le tampon en gros ou incliné est écarté', () => {
  const item = (str, extra = {}) => ({ str, x: 0, y: 0, width: 10, height: 9, page: 1, ...extra });

  // Incliné : filigrane, quel que soit le mot.
  assert.equal(isWatermarkItem(item('Mix vanille', { rotated: true }), 9), true);
  // Mot de tampon, mais à la taille du corps de texte : c'est une donnée.
  assert.equal(isWatermarkItem(item('Duplicata'), 9), false);
  // Mot de tampon imprimé au double : filigrane.
  assert.equal(isWatermarkItem(item('DUPLICATA', { height: 40 }), 9), true);
  // Un titre en gros qui n'est pas un tampon reste lu (« FACTURE », un montant…).
  assert.equal(isWatermarkItem(item('FACTURE', { height: 40 }), 9), false);
  assert.equal(isWatermarkItem(item('1 104,75', { height: 40 }), 9), false);
});

test('un code client (« CL9001 ») n’est jamais pris pour un nom', () => {
  const { name } = extractClient([
    'Siret : 00000000000000   N° client : CL9001',
    'LES GLACES DU PORT',
    '12 QUAI DU COMMERCE',
    '56100 LORIENT',
  ]);
  assert.equal(name, 'LES GLACES DU PORT');
});

test('le SIRET du vendeur intercalé avant le nom du client n’est jamais pris pour ce nom', () => {
  // Gabarit réel, constaté sur un lot entier de factures : la mention
  // « N° client » est imprimée dans la colonne de droite, juste au-dessus du
  // « Siret : » du **vendeur**, et le nom du client n'arrive qu'à la ligne
  // suivante, collé à une étiquette de la colonne de gauche. Prendre la
  // première ligne venue donnait « Siret : 80184990200011 » comme client sur
  // toutes les pièces à la fois.
  const { name, address } = extractClient([
    "EURL O'GELATO",
    '27 RUE JACQUES DAGUERRE',
    '44600 - ST NAZAIRE CEDEX 4460   N° client : CLT00000132',
    'Siret : 80184990200011',
    'Tél. : 09 54 93 49 90   Monsieur THIERRY SALOMON',
    'Port. : 06 98 72 20 40   385 chemin des chenes',
    'Email : contact@ogelato.fr   26230 Grignan',
  ]);
  assert.equal(name, 'Monsieur THIERRY SALOMON');
  // Et la ligne SIRET du vendeur ne s'invite pas non plus dans l'adresse.
  assert.equal(address, '385 chemin des chenes, 26230 Grignan');
});

test('une ligne mélangeant vendeur et client par colonnes est nettoyée dans l’adresse', () => {
  const { address } = extractClient([
    'Siret : 00000000000000   N° client : CL9001',
    'LES GLACES DU PORT',
    'Tél. : 01 23 45 67 89   12 QUAI DU COMMERCE',
    'Port. : 06 00 00 00 00   56100 LORIENT',
  ]);
  assert.equal(address, '12 QUAI DU COMMERCE, 56100 LORIENT');
});

test('téléphone et e-mail du client sont lus même après ses propres lignes Siret/Siren', () => {
  // Reproduit un bloc client réel : les lignes « N° Siret / N° Siren » du
  // client lui-même ne doivent pas couper la lecture avant Tél./E-mail.
  const { name, email, phone } = extractClient([
    'Facturé à :',
    'JEVENDEEGAUFRES',
    'MONSIEUR LANGUMIER',
    "85100 LES SABLES D'OLONNES",
    'FRANCE',
    'N° Siret : NC',
    'N° Siren : NC',
    'Tel : 0608421957',
    'Email : electricite.langumier@orange.fr',
  ]);
  assert.equal(name, 'JEVENDEEGAUFRES');
  assert.equal(phone, '0608421957');
  assert.equal(email, 'electricite.langumier@orange.fr');
});

test("le téléphone du vendeur fusionné sur la ligne d'adresse n'est jamais pris pour celui du client", () => {
  const { phone } = extractClient([
    'Siret : 00000000000000   N° client : CL9001',
    'LES GLACES DU PORT',
    'Tél. : 01 23 45 67 89   12 QUAI DU COMMERCE',
    'Port. : 06 00 00 00 00   56100 LORIENT',
  ]);
  assert.equal(phone, null);
});

/* ------------------------------------------------------------------ */
/* Pièces provisoires (factures brouillon tenant lieu de proforma)      */
/* ------------------------------------------------------------------ */

test('une facture brouillon est reconnue à son titre', () => {
  assert.equal(detectDraft('FACTURE BROUILLON\nN° : 1041'), true);
  assert.equal(detectDraft('Facture provisoire — ne vaut pas facture'), true);
  assert.equal(detectDraft('FACTURE\nN° : FA-2026-0142'), false);
});

test('le préfixe BRO du numéro suffit, même sous un titre neutre', () => {
  // MEG émet BRO00001041 puis la FAC correspondante : sans ce repère, la
  // vente serait comptée deux fois.
  assert.equal(detectDraft('FACTURE', '', 'BRO00001041'), true);
  assert.equal(detectDraft('FACTURE', '', 'FAC00001041'), false);
  // Un vrai numéro de facture commençant par « BRO » sans chiffre derrière
  // n'est pas un brouillon : le repère est le préfixe suivi du compteur.
  assert.equal(detectDraft('FACTURE', '', 'BROCHURE-2026'), false);
});

test('facture brouillon PDF : lue comme provisoire, totaux intacts', async () => {
  const file = path.join(pdfDir, 'BRO00001041.pdf');
  const doc = parsePdfDocument(await extractPdf(file), file);
  assert.equal(doc.kind, 'invoice');
  assert.equal(doc.number, 'BRO00001041');
  assert.equal(doc.draft, true);
  assert.equal(doc.totalHT, 180);
  assert.equal(doc.totalTTC, 216);
});

test('une facture définitive reste définitive', async () => {
  const file = path.join(pdfDir, 'FA-2026-0142.pdf');
  const doc = parsePdfDocument(await extractPdf(file), file);
  assert.equal(doc.draft, false);
});

/* ------------------------------------------------------------------ */
/* Bloc client : raison sociale, interlocuteur, fuite du vendeur        */
/* ------------------------------------------------------------------ */

/**
 * Gabarit réel d'une facture EURL O'GELATO : pavé vendeur à gauche, pavé client
 * à droite, fusionnés ligne à ligne par l'extraction PDF. Le client est une
 * association : sa fiche porte une raison sociale, et l'interlocuteur est rangé
 * faute de place dans la première ligne d'adresse.
 */
const BLOC_DEUX_COLONNES = [
  'Siret : **********0011',
  'N° TVA : NC',
  'N° client : CLT00000339',
  'Tél. : 09 54 93 49 90   SNSM LE CROISIC',
  'Port. : 06 98 72 20 40   LUCIE DEBEC',
  'Email : contact@ogelato.fr   2 PLACE DU TREHIC',
  'Monsieur Hervé GUEGUEN - GERANT   44490 LE CROISIC',
  'FRANCE',
  'N° Siret : NC',
  'N° Siren : NC',
  'Tel : 06 42 10 30 28',
  'Email : lucile.dedec@snsm.org',
];

test('le nom retenu est la raison sociale, pas l’interlocuteur', () => {
  assert.equal(extractClient(BLOC_DEUX_COLONNES).name, 'SNSM LE CROISIC');
});

test('l’interlocuteur sort de l’adresse et devient un contact', () => {
  const { contact, address } = extractClient(BLOC_DEUX_COLONNES);
  assert.equal(contact, 'LUCIE DEBEC');
  assert.equal(address, '2 PLACE DU TREHIC, 44490 LE CROISIC');
});

test('le gérant du vendeur ne s’invite pas dans l’adresse du client', () => {
  // Sans nettoyage, « Monsieur Hervé GUEGUEN - GERANT » — imprimé seul en bas du
  // pavé de gauche — se collait à la ligne de code postal de chaque client.
  const { address } = extractClient(BLOC_DEUX_COLONNES);
  assert.ok(!/GUEGUEN/i.test(address), `nom du vendeur dans l’adresse : ${address}`);
});

test('le téléphone et l’e-mail retenus restent ceux du client', () => {
  const { email, phone } = extractClient(BLOC_DEUX_COLONNES);
  assert.equal(email, 'lucile.dedec@snsm.org');
  assert.equal(phone, '0642103028');
});

test('un client sans interlocuteur garde son adresse entière', () => {
  const { contact, address, name } = extractClient([
    'Facturé à :',
    'LES GLACES DU PORT',
    '12 QUAI DU COMMERCE',
    '56100 LORIENT',
  ]);
  assert.equal(name, 'LES GLACES DU PORT');
  assert.equal(contact, null);
  assert.equal(address, '12 QUAI DU COMMERCE, 56100 LORIENT');
});

test('une ligne d’adresse sans numéro de voie n’est pas prise pour un contact', () => {
  // Le repère exige que la ligne suivante commence par un numéro : dans le
  // doute, la ligne reste dans l'adresse. Une adresse amputée coûte plus cher
  // qu'un contact manqué.
  const { contact, address } = extractClient([
    'Facturé à :',
    'MAIRIE DE PORNICHET',
    'Place du Marché',
    '44380 PORNICHET',
  ]);
  assert.equal(contact, null);
  assert.equal(address, 'Place du Marché, 44380 PORNICHET');
});

/* ------------------------------------------------------------------ */
/* Type lu ou supposé : qui l'emporte sur le classement du dossier      */
/* ------------------------------------------------------------------ */

test('un titre DEVIS est une lecture, pas une supposition', () => {
  const r = detectKindDetailed('DEVIS\nN° : DEV00000622', 'DEV00000622.pdf');
  assert.deepEqual(r, { kind: 'quote', sure: true });
});

test('le nom de fichier d’un logiciel de facturation suffit', () => {
  // « DEV00000622 » devient « dev 00000622 » une fois normalisé : le repli
  // doit tolérer cette séparation, sinon il ne se déclenche jamais.
  const r = detectKindDetailed('Prestation location machine', 'DEV00000622.pdf');
  assert.deepEqual(r, { kind: 'quote', sure: true });
});

test('un document illisible retombe sur « facture », en le disant', () => {
  // C'est le seul cas où le classement du dossier a le dernier mot.
  const r = detectKindDetailed('Document scanné illisible', 'scan001.pdf');
  assert.deepEqual(r, { kind: 'invoice', sure: false });
});

test('un mot qui commence par « dev » n’est pas un devis', () => {
  const r = detectKindDetailed('Prestation', 'developpement-2026.pdf');
  assert.equal(r.kind, 'invoice');
  assert.equal(r.sure, false);
});

test('avoir et facture restent reconnus, et sûrs', () => {
  assert.deepEqual(detectKindDetailed('AVOIR N° AV-12', 'AV-12.pdf'), {
    kind: 'credit',
    sure: true,
  });
  assert.deepEqual(detectKindDetailed('FACTURE\nN° : FAC00002222', 'FAC00002222.pdf'), {
    kind: 'invoice',
    sure: true,
  });
});

/* ------------------------------------------------------------------ */
/* Gabarit DEVIS : le bloc client est loin du repère « N° client »      */
/* ------------------------------------------------------------------ */

/**
 * Sur ce gabarit, « N° client : » est imprimé en haut à droite tandis que le
 * bloc client arrive bien plus bas. La fenêtre de recherche traverse donc
 * d'abord toute la colonne du vendeur — sa ligne pays fusionnée avec la
 * validité du devis se présentait alors comme un nom de client.
 */
function devis(numero, client, ligne1, ville, contactLigne) {
  return [
    'DEVIS',
    `EURL O'GELATO                    N° : ${numero}`,
    "27 RUE JACQUES DAGUERRE           Date d'émission : 30/07/2026",
    `44600 - ST NAZAIRE CEDEX 4460     N° client : ${client.ref}`,
    "FRANCE                            Devis valable jusqu'au 29/08/2026",
    'Siret : 80184990200011',
    'Tél. : 09 54 93 49 90',
    `Port. : 06 98 72 20 40            ${client.nom}`,
    `Email : contact@ogelato.fr        ${contactLigne}`,
    ligne1,
    ville,
    'FRANCE',
    'Tel 1 : 0628791735',
  ];
}

test('la ligne pays du vendeur n’est jamais prise pour le client', () => {
  const { name } = extractClient(
    devis('DEV00000613', { ref: 'CLT00000361', nom: 'Candy Breizh' },
      '8, RUE DES COQUELICOTS', '29800 LANDERNEAU', 'JULIE LOUSSOUARN'),
  );
  assert.equal(name, 'Candy Breizh');
});

test('sur ce gabarit aussi, l’interlocuteur part en contact', () => {
  const { contact, address } = extractClient(
    devis('DEV00000613', { ref: 'CLT00000361', nom: 'Candy Breizh' },
      '8, RUE DES COQUELICOTS', '29800 LANDERNEAU', 'JULIE LOUSSOUARN'),
  );
  assert.equal(contact, 'JULIE LOUSSOUARN');
  assert.equal(address, '8, RUE DES COQUELICOTS, 29800 LANDERNEAU');
});

test('un client nommé sans raison sociale reste lui-même', () => {
  const { name } = extractClient(
    devis('DEV00000616', { ref: 'CLT00000366', nom: 'Madame KRISTELA LIPOVAC' },
      '56760 PENESTIN', 'FRANCE', "PLACE DE L'EGLISE"),
  );
  assert.equal(name, 'Madame KRISTELA LIPOVAC');
});

test('une mention du document n’est pas un nom de client', () => {
  assert.equal(looksLikeClientName("FRANCE Devis valable jusqu'au 29/08/2026"), false);
  assert.equal(looksLikeClientName('Date et signature'), false);
  assert.equal(looksLikeClientName('Acompte demandé 50,00 %'), false);
  assert.equal(looksLikeClientName('FRANCE'), false);
});

test('un vrai nom qui commence par un pays reste accepté', () => {
  // « FRANCE BOISSONS » est une entreprise bien réelle : le motif du pays est
  // ancré aux deux bouts, sinon la prudence coûterait plus cher que le cas
  // qu'elle écarte.
  assert.equal(looksLikeClientName('FRANCE BOISSONS'), true);
  assert.equal(looksLikeClientName('Candy Breizh'), true);
  assert.equal(looksLikeClientName('SEGWICK'), true);
});

test('un alias douteux ne sert plus de point de comparaison', () => {
  // Mécanique de l'emballement : un premier rapprochement malheureux
  // inscrivait le texte lu comme alias ; l'alias servait ensuite lui-même de
  // comparaison, si bien que chaque devis suivant — dont la mention ne
  // changeait que d'une date — retombait sur le même client. Des dizaines de
  // pièces attribuées à un client qui n'y figure pas.
  const pollue = {
    id: 'cli_1', name: 'Rondeau Vincent', aliases: ["FRANCE Devis valable jusqu'au 29/08/2026"],
    archived: false,
  };
  const autre = { id: 'cli_2', name: 'Candy Breizh', aliases: [], archived: false };
  const match = matchClient([pollue, autre], "FRANCE Devis valable jusqu'au 04/09/2026");
  assert.equal(match, null, 'le mauvais alias attire encore les pièces');
});

test('un alias qui ne peut pas être un nom n’est pas mémorisé', () => {
  // Le garde-fou vaut aussi à l'écriture : rien n'oblige à attendre la
  // relecture pour cesser de salir une fiche.
  assert.doesNotThrow(() => rememberClientAlias('cli_inexistant', 'Date et signature'));
});

/* ------------------------------------------------------------------ */
/* Récapitulatif de TVA : une table qui n'est pas un tableau d'articles  */
/* ------------------------------------------------------------------ */

/**
 * Compose une page à la main plutôt que de fabriquer un PDF : la mise en page
 * qui pose problème se décrit en cinq colonnes et trois lignes.
 */
function page(rows) {
  const lines = rows.map(({ y, cells }) => {
    const items = cells.map(([str, x, width]) => ({
      str,
      x,
      y,
      width,
      height: 10,
      page: 1,
    }));
    return { page: 1, y, text: cells.map(([str]) => str).join(' '), items };
  });
  return { text: '', lines, pages: 1, attachments: [], info: {} };
}

const COLONNES = [40, 100, 300, 352, 432];

function ligne(y, valeurs, largeurs) {
  return { y, cells: valeurs.map((v, i) => [v, COLONNES[i], largeurs[i]]) };
}

test('le récapitulatif de TVA n’est pas lu comme des articles', () => {
  // C'est la mise en page du bas de facture : à gauche le récapitulatif de
  // TVA, à droite les totaux, sur les mêmes lignes visuelles. Aucune de ces
  // lignes ne commence par « Total », donc rien n'arrêtait la lecture — et
  // « Réduite 450,88 € 5,50% 24,80 € » devenait un article de quantité 1,
  // d'unité « Total TTC ».
  const extract = page([
    ligne(700, ['Réf.', 'Désignation', 'Qté', 'PU HT', 'Montant HT'], [25, 70, 20, 30, 60]),
    ligne(680, ['CUP-100', 'CUP-100 -Coupelle carton', '12', '8,90', '106,80'], [40, 120, 12, 25, 35]),
    ligne(660, ['REM', 'REM -Remise 5%', '1', '-5,34', '-5,34'], [30, 120, 8, 28, 30]),
    ligne(600, ['Réduite', '450,88 €', '5,50%', '24,80 €', 'Total TTC'], [40, 45, 30, 40, 50]),
    ligne(580, ['Normale', '144,00 €', '20,00%', '28,80 €', '475,68 €'], [40, 45, 35, 40, 45]),
  ]);

  const { lines } = extractLinesFromPdf(extract);

  assert.deepEqual(
    lines.map((l) => l.label),
    ['CUP-100 -Coupelle carton', 'REM -Remise 5%'],
    `lignes lues : ${JSON.stringify(lines.map((l) => l.label))}`,
  );
  assert.equal(lines[0].qty, 12);
  assert.equal(lines[0].unitPriceHT, 8.9);
  // Une remise porte bien un pourcentage : elle appartient à la commande, et
  // ne doit pas tomber avec le récapitulatif.
  assert.equal(lines[1].totalHT, -5.34);
});

test('un nom de taux sans pourcentage reste un article', () => {
  assert.equal(looksLikeVatRecapRow('Réduite 450,88 € 5,50% 24,80 €'), true);
  assert.equal(looksLikeVatRecapRow('Normale 144,00 € 20,00%'), true);
  assert.equal(looksLikeVatRecapRow('Taux normal 20 %'), true);
  // Un pourcentage seul, ou un intitulé seul, ne suffit pas.
  assert.equal(looksLikeVatRecapRow('Remise 5%'), false);
  assert.equal(looksLikeVatRecapRow('Réduction commerciale'), false);
  assert.equal(looksLikeVatRecapRow('Coupelle carton 100 ml'), false);
  assert.equal(looksLikeVatRecapRow(''), false);
});
