import type { Product, Role } from './types';

/**
 * Ce qu'un rôle a le droit de voir d'un article.
 *
 * Le livreur a besoin du catalogue : c'est lui qui alimente les suggestions
 * quand il établit un bon devant le client, et qui permet de répondre à un
 * « ça coûte combien, ce bac ? ». Il n'a en revanche aucune raison de
 * connaître le **prix d'achat** ni le **fournisseur** — de quoi reconstituer
 * la marge de l'entreprise sur un téléphone qui vit dans une camionnette.
 *
 * Le retrait se fait **au serveur**, pas à l'affichage : ces champs ne
 * descendent jamais dans son miroir, donc ils ne sont ni lisibles hors ligne,
 * ni récupérables en interrogeant l'API à la main.
 */
export function productForRole(product: Product, role: Role): Product {
  if (role !== 'livreur') return product;
  const { unitCost: _unitCost, supplier: _supplier, ...visible } = product;
  return visible;
}

/** La même règle, sur une liste. */
export function productsForRole(products: Product[], role: Role): Product[] {
  if (role !== 'livreur') return products;
  return products.map((product) => productForRole(product, role));
}
