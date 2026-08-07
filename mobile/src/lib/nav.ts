import { Linking } from 'react-native';
import type { Address, RouteStop, Settings } from '@shared/types';

/**
 * Gestes du téléphone : naviguer, appeler, écrire. Les adresses viennent des
 * fiches ; les liens se construisent ici, localement — pas besoin du serveur
 * pour lancer Waze vers un arrêt.
 */

function destination(address: Address): string {
  if (address.lat !== undefined && address.lon !== undefined) {
    return `${address.lat},${address.lon}`;
  }
  return encodeURIComponent(address.label);
}

/** Lien de navigation vers un arrêt, selon le fournisseur choisi aux réglages. */
export function navigationUrl(stop: RouteStop, provider: Settings['mapProvider']): string {
  const to = destination(stop.address);
  switch (provider) {
    case 'waze':
      return stop.address.lat !== undefined
        ? `https://waze.com/ul?ll=${to}&navigate=yes`
        : `https://waze.com/ul?q=${to}&navigate=yes`;
    case 'apple':
      return `https://maps.apple.com/?daddr=${to}&dirflg=d`;
    default:
      return `https://www.google.com/maps/dir/?api=1&destination=${to}&travelmode=driving`;
  }
}

export function openNavigation(stop: RouteStop, provider: Settings['mapProvider']): void {
  void Linking.openURL(navigationUrl(stop, provider));
}

export function call(phone: string): void {
  void Linking.openURL(`tel:${phone.replace(/[\s.]/g, '')}`);
}

/** Brouillon d'e-mail dans la messagerie du téléphone. */
export function openMailto(to: string, subject: string, body: string, cc?: string): void {
  const query = [
    `subject=${encodeURIComponent(subject)}`,
    `body=${encodeURIComponent(body)}`,
    ...(cc ? [`cc=${encodeURIComponent(cc)}`] : []),
  ].join('&');
  void Linking.openURL(`mailto:${encodeURIComponent(to)}?${query}`);
}
