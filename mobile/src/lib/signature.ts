import { File, Paths } from 'expo-file-system';
import type { Strokes } from '../components/SignaturePad';

/**
 * La signature du livreur, gardée sur l'appareil.
 *
 * Signer une fois suffit : les bons suivants la reprennent d'un geste. Elle ne
 * quitte le téléphone qu'à l'intérieur d'un bon — jamais dans la
 * synchronisation générale.
 */

const FILE = 'ma-signature.json';

export async function loadMySignature(): Promise<Strokes | null> {
  try {
    const file = new File(Paths.document, FILE);
    if (!file.exists) return null;
    const parsed = JSON.parse(await file.text()) as Strokes;
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveMySignature(strokes: Strokes): Promise<void> {
  try {
    const file = new File(Paths.document, FILE);
    file.write(JSON.stringify(strokes));
  } catch {
    /* mémoire pleine ou stockage indisponible : on resignera, rien de grave */
  }
}
