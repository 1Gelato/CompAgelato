import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPdf,
  parsePdfDocument,
  parseEInvoiceXml,
  extractClient,
  isWatermarkItem,
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
