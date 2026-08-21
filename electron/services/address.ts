import type { Address } from '@shared/types';

/**
 * Découpage d'une adresse écrite en une seule ligne.
 *
 * Les listes clients importées et les fiches créées depuis un document
 * arrivent souvent avec tout dans la même ligne : « 10 RUE MAURICE GRIMAUD
 * 75018 PARIS FRANCE », parfois avec un e-mail ou un téléphone collés au
 * milieu. Tant que code postal et ville ne sont pas isolés, la colonne Ville
 * reste vide et la géolocalisation cherche une adresse qui n'existe pas.
 *
 * Ce module vit sans dépendance : le magasin l'appelle au chargement pour
 * réparer les fiches déjà enregistrées.
 */

/** Pays reconnus en fin de ligne — celui par défaut reste la France. */
const COUNTRIES: Record<string, string> = {
  france: 'France',
  belgique: 'Belgique',
  suisse: 'Suisse',
  luxembourg: 'Luxembourg',
  monaco: 'Monaco',
  espagne: 'Espagne',
  italie: 'Italie',
  allemagne: 'Allemagne',
};

/**
 * Retire d'une ligne d'adresse ce qui n'en fait pas partie : e-mails et
 * numéros de téléphone recopiés depuis un document comptable.
 */
export function cleanAddressLine(line: string): string {
  return line
    .replace(/\S+@\S+\.\S+/g, ' ')
    // Un téléphone français : dix chiffres commençant par 0, éventuellement
    // espacés ou pointés par paires. Un code postal n'en a que cinq.
    .replace(/\b0[1-9](?:[\s.]?\d{2}){4}\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Extrait rue, code postal, ville et pays d'une adresse en une ligne. */
export function parseAddressLine(line: string): Partial<Address> {
  const out: Partial<Address> = {};
  if (!line) return out;

  let text = cleanAddressLine(line);

  // Le pays s'écrit en fin de ligne : on le détache avant de chercher la ville.
  const countryMatch = text.match(/[\s,;-]+([A-Za-zÀ-ÿ]+)\s*$/);
  if (countryMatch) {
    const country = COUNTRIES[countryMatch[1].toLowerCase()];
    if (country) {
      out.country = country;
      text = text.slice(0, countryMatch.index).trim();
    }
  }

  const m = text.match(/\b(\d{5})\b[\s,-]*([A-Za-zÀ-ÿ' -]{2,40})/);
  if (m) {
    out.postcode = m[1];
    // « NANTES CEDEX 3 » : le cedex est une mention postale, pas la ville.
    out.city = m[2].trim().replace(/[,;]$/, '').replace(/\s+cedex\b.*$/i, '').trim();
    out.street = text.slice(0, m.index).replace(/[,;\s-]+$/, '').trim() || undefined;
  } else {
    out.street = text.trim() || undefined;
  }
  return out;
}

/**
 * Complète et nettoie une adresse. Retourne null quand il n'y a rien à
 * réparer — la fiche reste alors intacte, jusqu'à l'octet près.
 *
 * Deux réparations, indépendantes l'une de l'autre :
 *
 * - **le découpage**, quand tout est resté dans la ligne complète ;
 * - **le nettoyage**, quand un e-mail ou un téléphone a été saisi au milieu de
 *   l'adresse. Celui-ci vaut même pour une fiche déjà découpée : ces scories
 *   s'affichent dans le carnet et empêchent le service d'adresses de
 *   reconnaître la rue.
 */
export function repairAddress(address: Address): Address | null {
  if (!address.label) return null;

  const split = Boolean(address.postcode && address.city);
  const label = cleanAddressLine(address.label);
  const street = address.street ? cleanAddressLine(address.street) : address.street;

  // Déjà découpée et déjà propre : on ne touche à rien.
  if (split && label === address.label && street === address.street) return null;

  const parsed = split ? {} : parseAddressLine(address.label);
  // Rien d'exploitable et rien à nettoyer : on n'invente pas une adresse.
  if (!split && !parsed.postcode && !parsed.city && !parsed.street) return null;

  const repaired: Address = {
    ...address,
    label,
    street: street ?? parsed.street,
    postcode: address.postcode ?? parsed.postcode,
    city: address.city ?? parsed.city,
    country: address.country ?? parsed.country ?? 'France',
  };
  // Quand tout a pu être isolé, la ligne se réécrit proprement — sans le pays
  // ni les scories qui gênaient la géolocalisation.
  if (repaired.street && repaired.postcode && repaired.city) {
    repaired.label = `${repaired.street}, ${repaired.postcode} ${repaired.city}`;
  }
  const changed =
    repaired.street !== address.street ||
    repaired.postcode !== address.postcode ||
    repaired.city !== address.city ||
    repaired.country !== address.country ||
    repaired.label !== address.label;
  return changed ? repaired : null;
}
