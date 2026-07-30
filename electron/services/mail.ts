import fs from 'node:fs';
import path from 'node:path';

/**
 * Construction d'un brouillon d'e-mail au format `.eml` (MIME multipart).
 *
 * Un lien `mailto:` ne sait pas transporter de pièce jointe : on écrit donc un
 * fichier `.eml` que l'on ouvre avec le logiciel de messagerie par défaut.
 * L'en-tête `X-Unsent: 1` demande à Outlook d'ouvrir le message en rédaction
 * plutôt qu'en lecture — le message est prêt à être relu puis envoyé.
 */

export interface MailAttachment {
  filePath: string;
  /** Nom affiché dans le message ; par défaut le nom du fichier. */
  fileName?: string;
}

export interface MailDraft {
  to: string;
  cc?: string;
  from?: string;
  subject: string;
  body: string;
  attachments: MailAttachment[];
}

const CRLF = '\r\n';

/** Types MIME des pièces jointes courantes d'un artisan (documents, images). */
const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Encode un en-tête contenant des accents (RFC 2047).
 * « Devis n°12 — Été » ne peut pas voyager tel quel dans un en-tête ASCII.
 */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Encode un nom de fichier de pièce jointe (RFC 2231) pour préserver les accents. */
function encodeFileName(name: string): string {
  const ascii = /^[\x20-\x7e]*$/.test(name);
  if (ascii) return `filename="${name.replace(/"/g, '')}"`;
  return `filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Découpe une chaîne base64 en lignes de 76 caractères, comme l'exige MIME. */
function wrapBase64(data: string): string {
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += 76) lines.push(data.slice(i, i + 76));
  return lines.join(CRLF);
}

export interface BuildResult {
  content: string;
  /** Taille totale des pièces jointes, en octets, avant encodage. */
  attachmentBytes: number;
  missing: string[];
}

/** Assemble le message complet. Les pièces jointes introuvables sont signalées. */
export function buildEml(draft: MailDraft): BuildResult {
  const boundary = `----=_CompaGelato_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const missing: string[] = [];
  let attachmentBytes = 0;

  const headers = [
    `Date: ${new Date().toUTCString()}`,
    draft.from ? `From: ${draft.from}` : null,
    `To: ${draft.to}`,
    draft.cc ? `Cc: ${draft.cc}` : null,
    `Subject: ${encodeHeader(draft.subject)}`,
    'MIME-Version: 1.0',
    // Demande au client de messagerie d'ouvrir le message en rédaction.
    'X-Unsent: 1',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter((h): h is string => h !== null);

  const parts: string[] = [];

  // Corps du message.
  parts.push(
    [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(draft.body, 'utf8').toString('base64')),
    ].join(CRLF),
  );

  for (const attachment of draft.attachments) {
    let data: Buffer;
    try {
      data = fs.readFileSync(attachment.filePath);
    } catch {
      missing.push(attachment.fileName ?? path.basename(attachment.filePath));
      continue;
    }
    attachmentBytes += data.length;
    const name = attachment.fileName ?? path.basename(attachment.filePath);
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${mimeTypeFor(attachment.filePath)}; name="${name.replace(/"/g, '')}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; ${encodeFileName(name)}`,
        '',
        wrapBase64(data.toString('base64')),
      ].join(CRLF),
    );
  }

  const content = [
    headers.join(CRLF),
    '',
    parts.join(CRLF + CRLF),
    CRLF + `--${boundary}--`,
    '',
  ].join(CRLF);

  return { content, attachmentBytes, missing };
}

/** Lien `mailto:` de secours, sans pièce jointe, si le `.eml` ne s'ouvre pas. */
export function buildMailto(draft: Pick<MailDraft, 'to' | 'cc' | 'subject' | 'body'>): string {
  const params = new URLSearchParams();
  if (draft.cc) params.set('cc', draft.cc);
  params.set('subject', draft.subject);
  params.set('body', draft.body);
  return `mailto:${encodeURIComponent(draft.to)}?${params.toString().replace(/\+/g, '%20')}`;
}

/** Remplace les repères d'un modèle de message par leurs valeurs. */
export function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** Nom de fichier sûr pour tous les systèmes. */
export function safeFileName(input: string, fallback = 'document'): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}
