import { XMLParser } from 'fast-xml-parser';
import type { DocumentKind } from '@shared/types';
import type { ParsedDocument, ParsedLine } from './parseInvoice';
import { parseDate, parseNumber, round2 } from './text';

/**
 * Lecture des factures électroniques : Factur-X / ZUGFeRD (CII UN/CEFACT) et
 * UBL 2.1 (Peppol / Chorus Pro). Les préfixes de namespace sont retirés, on
 * travaille donc sur les noms d'éléments seuls.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

type Node = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Valeur texte d'un nœud, qu'il soit une chaîne ou un objet à attributs. */
function textOf(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (typeof node === 'object') {
    const o = node as Node;
    if ('#text' in o) return String(o['#text']).trim();
  }
  return null;
}

/** Recherche en profondeur le premier nœud portant l'un des noms donnés. */
function findFirst(root: unknown, names: string[], maxDepth = 14): unknown {
  const wanted = new Set(names);
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.shift()!;
    if (depth > maxDepth || node == null || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node as Node)) {
      if (wanted.has(key)) return Array.isArray(value) ? value[0] : value;
    }
    for (const value of Object.values(node as Node)) {
      if (Array.isArray(value)) for (const v of value) stack.push({ node: v, depth: depth + 1 });
      else if (value && typeof value === 'object') stack.push({ node: value, depth: depth + 1 });
    }
  }
  return undefined;
}

function findAll(root: unknown, name: string, maxDepth = 14): unknown[] {
  const out: unknown[] = [];
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.shift()!;
    if (depth > maxDepth || node == null || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node as Node)) {
      if (key === name) out.push(...asArray(value));
      if (Array.isArray(value)) for (const v of value) stack.push({ node: v, depth: depth + 1 });
      else if (value && typeof value === 'object') stack.push({ node: value, depth: depth + 1 });
    }
  }
  return out;
}

function textIn(root: unknown, names: string[]): string | null {
  return textOf(findFirst(root, names));
}

function numberIn(root: unknown, names: string[]): number | null {
  return parseNumber(textIn(root, names));
}

export function looksLikeEInvoice(xml: string): boolean {
  return /CrossIndustryInvoice|<Invoice|<CreditNote|rsm:|urn:un:unece:uncefact|urn:oasis:names:specification:ubl/i.test(
    xml.slice(0, 4000),
  );
}

function kindFromTypeCode(code: string | null, rootName: string): DocumentKind {
  if (rootName === 'CreditNote') return 'credit';
  switch ((code ?? '').trim()) {
    case '381':
    case '261':
      return 'credit';
    case '325': // facture pro forma
    case '310': // offre / devis
      return 'quote';
    default:
      return 'invoice';
  }
}

/** Analyse une facture électronique (contenu XML) et renvoie un ParsedDocument. */
export function parseEInvoiceXml(xml: string): ParsedDocument | null {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch {
    return null;
  }
  const rootName = Object.keys(doc).find((k) => !k.startsWith('?')) ?? '';
  const root = doc[rootName];
  if (!root || typeof root !== 'object') return null;

  const warnings: string[] = [];
  const isCII = rootName.includes('CrossIndustryInvoice');

  /* Numéro et type ------------------------------------------------- */
  const header = isCII ? findFirst(root, ['ExchangedDocument']) : root;
  const number = textIn(header, ['ID', 'DocumentID']) ?? '';
  const typeCode = textIn(header, ['TypeCode', 'InvoiceTypeCode']);
  const kind = kindFromTypeCode(typeCode, rootName);

  /* Dates ----------------------------------------------------------- */
  let date: string | null = null;
  if (isCII) {
    const issue = findFirst(header, ['IssueDateTime']);
    date = parseDate(textIn(issue, ['DateTimeString']) ?? textOf(issue));
  } else {
    date = parseDate(textIn(root, ['IssueDate']));
  }

  let dueDate: string | null = null;
  if (isCII) {
    const terms = findFirst(root, ['SpecifiedTradePaymentTerms']);
    const due = findFirst(terms, ['DueDateDateTime']);
    dueDate = parseDate(textIn(due, ['DateTimeString']) ?? textOf(due));
  } else {
    dueDate = parseDate(textIn(root, ['DueDate']));
  }

  /* Client ---------------------------------------------------------- */
  const buyer = isCII
    ? findFirst(root, ['BuyerTradeParty'])
    : findFirst(findFirst(root, ['AccountingCustomerParty']), ['Party']);

  let clientName = textIn(buyer, ['Name', 'RegistrationName']);
  if (!clientName) clientName = textIn(findFirst(buyer, ['PartyName']), ['Name']);
  if (!clientName) clientName = textIn(findFirst(buyer, ['PartyLegalEntity']), ['RegistrationName']);

  const addrNode = findFirst(buyer, ['PostalTradeAddress', 'PostalAddress']);
  const addrParts = [
    textIn(addrNode, ['LineOne', 'StreetName']),
    textIn(addrNode, ['LineTwo', 'AdditionalStreetName']),
    [textIn(addrNode, ['PostcodeCode', 'PostalZone']), textIn(addrNode, ['CityName'])].filter(Boolean).join(' '),
  ].filter((p) => p && p.trim().length);
  const clientAddress = addrParts.length ? addrParts.join(', ') : null;

  let clientSiret: string | null = null;
  for (const id of findAll(buyer, 'ID')) {
    const value = textOf(id);
    const scheme = typeof id === 'object' && id ? String((id as Node)['@schemeID'] ?? '') : '';
    if (value && (/^0009$/.test(scheme) || /^\d{14}$/.test(value.replace(/\s/g, '')))) {
      clientSiret = value.replace(/\D/g, '');
      break;
    }
  }

  const contact = findFirst(buyer, ['DefinedTradeContact', 'Contact']);
  const clientEmail = textIn(contact, ['URIID', 'ElectronicMail', 'EMail']);
  const clientPhone = textIn(contact, ['CompleteNumber', 'Telephone', 'TelephoneNumber']);

  /* Totaux ---------------------------------------------------------- */
  const summation = isCII
    ? findFirst(root, ['SpecifiedTradeSettlementHeaderMonetarySummation'])
    : findFirst(root, ['LegalMonetaryTotal']);

  const totalHT = isCII
    ? numberIn(summation, ['TaxBasisTotalAmount']) ?? numberIn(summation, ['LineTotalAmount'])
    : numberIn(summation, ['TaxExclusiveAmount']) ?? numberIn(summation, ['LineExtensionAmount']);

  let totalVAT = isCII ? numberIn(summation, ['TaxTotalAmount']) : null;
  if (totalVAT === null) {
    const taxTotal = findFirst(root, ['TaxTotal']);
    totalVAT = numberIn(taxTotal, ['TaxAmount']);
  }

  const totalTTC = isCII
    ? numberIn(summation, ['GrandTotalAmount']) ?? numberIn(summation, ['DuePayableAmount'])
    : numberIn(summation, ['TaxInclusiveAmount']) ?? numberIn(summation, ['PayableAmount']);

  const currency =
    textIn(root, ['InvoiceCurrencyCode', 'DocumentCurrencyCode']) ??
    (typeof summation === 'object' && summation
      ? String((findFirst(summation, ['GrandTotalAmount']) as Node)?.['@currencyID'] ?? 'EUR')
      : 'EUR');

  /* Lignes ---------------------------------------------------------- */
  const lineNodes = isCII
    ? findAll(root, 'IncludedSupplyChainTradeLineItem')
    : [...findAll(root, 'InvoiceLine'), ...findAll(root, 'CreditNoteLine')];

  const lines: ParsedLine[] = [];
  for (const node of lineNodes) {
    if (isCII) {
      const product = findFirst(node, ['SpecifiedTradeProduct']);
      const label = textIn(product, ['Name']) ?? 'Ligne';
      const ref = textIn(product, ['SellerAssignedID', 'BuyerAssignedID', 'GlobalID']) ?? undefined;
      const delivery = findFirst(node, ['SpecifiedLineTradeDelivery']);
      const qtyNode = findFirst(delivery, ['BilledQuantity']);
      const qty = parseNumber(textOf(qtyNode)) ?? 1;
      const unit = typeof qtyNode === 'object' && qtyNode ? String((qtyNode as Node)['@unitCode'] ?? '') : '';
      const agreement = findFirst(node, ['SpecifiedLineTradeAgreement']);
      const price =
        numberIn(findFirst(agreement, ['NetPriceProductTradePrice']), ['ChargeAmount']) ??
        numberIn(findFirst(agreement, ['GrossPriceProductTradePrice']), ['ChargeAmount']);
      const settlement = findFirst(node, ['SpecifiedLineTradeSettlement']);
      const total = numberIn(findFirst(settlement, ['SpecifiedTradeSettlementLineMonetarySummation']), [
        'LineTotalAmount',
      ]);
      const vatRate = numberIn(findFirst(settlement, ['ApplicableTradeTax']), ['RateApplicablePercent']);
      lines.push({
        ref,
        label,
        qty,
        unit: unitCodeToLabel(unit),
        unitPriceHT: price ?? undefined,
        totalHT: total ?? (price !== null && price !== undefined ? round2(price * qty) : undefined),
        vatRate: vatRate ?? undefined,
      });
    } else {
      const item = findFirst(node, ['Item']);
      const label = textIn(item, ['Name', 'Description']) ?? 'Ligne';
      const ref =
        textIn(findFirst(item, ['SellersItemIdentification']), ['ID']) ??
        textIn(findFirst(item, ['StandardItemIdentification']), ['ID']) ??
        undefined;
      const qtyNode = findFirst(node, ['InvoicedQuantity', 'CreditedQuantity']);
      const qty = parseNumber(textOf(qtyNode)) ?? 1;
      const unit = typeof qtyNode === 'object' && qtyNode ? String((qtyNode as Node)['@unitCode'] ?? '') : '';
      const price = numberIn(findFirst(node, ['Price']), ['PriceAmount']);
      const total = numberIn(node, ['LineExtensionAmount']);
      const vatRate = numberIn(findFirst(item, ['ClassifiedTaxCategory']), ['Percent']);
      lines.push({
        ref,
        label,
        qty,
        unit: unitCodeToLabel(unit),
        unitPriceHT: price ?? undefined,
        totalHT: total ?? undefined,
        vatRate: vatRate ?? undefined,
      });
    }
  }

  if (!number) warnings.push('Numéro absent du fichier XML.');
  if (!lines.length) warnings.push('Aucune ligne de détail dans le fichier XML.');
  if (!clientName) warnings.push('Client absent du fichier XML.');

  return {
    kind,
    // Une facture structurée est une pièce définitive : elle est émise pour
    // être déposée et payée, pas pour tenir lieu de proforma.
    draft: false,
    // Une facture structurée porte son code de type : rien à supposer.
    kindSure: true,
    number: number || 'SANS-NUMERO',
    date,
    dueDate,
    clientName,
    clientAddress,
    clientSiret,
    clientEmail,
    clientPhone,
    clientContact: null,
    currency: currency || 'EUR',
    totalHT,
    totalVAT,
    totalTTC,
    lines,
    // Une facture électronique est structurée : la confiance est élevée par nature.
    confidence: Math.max(0.6, 1 - warnings.length * 0.12),
    warnings,
  };
}

/** Codes d'unité UN/ECE Rec. 20 les plus courants → libellé lisible. */
const UNIT_CODES: Record<string, string> = {
  C62: 'pièce',
  H87: 'pièce',
  EA: 'pièce',
  NAR: 'pièce',
  KGM: 'kg',
  GRM: 'g',
  LTR: 'L',
  MLT: 'ml',
  MTR: 'm',
  MTK: 'm²',
  HUR: 'heure',
  DAY: 'jour',
  BX: 'carton',
  CT: 'carton',
  PK: 'paquet',
  SET: 'lot',
};

export function unitCodeToLabel(code: string): string | undefined {
  if (!code) return undefined;
  return UNIT_CODES[code.toUpperCase()] ?? code;
}

/** Cherche une pièce jointe Factur-X/ZUGFeRD/Order-X dans les fichiers embarqués d'un PDF. */
export function pickEInvoiceAttachment(
  attachments: { name: string; data: Uint8Array }[],
): { name: string; xml: string } | null {
  const preferred = /^(factur-x|zugferd-invoice|xrechnung|order-x|factur_x)/i;
  const candidates = attachments.filter((a) => /\.xml$/i.test(a.name));
  const sorted = [
    ...candidates.filter((a) => preferred.test(a.name)),
    ...candidates.filter((a) => !preferred.test(a.name)),
  ];
  for (const att of sorted) {
    try {
      const xml = Buffer.from(att.data).toString('utf8');
      if (looksLikeEInvoice(xml)) return { name: att.name, xml };
    } catch {
      continue;
    }
  }
  return null;
}
