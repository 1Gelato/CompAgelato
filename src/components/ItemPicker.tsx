import { useMemo, useState } from 'react';
import type { Product, ProductType, RegisterItem } from '@shared/types';
import { Badge, Button, Field, Icons, IconButton, Input, NumberInput } from './ui';
import { useProducts } from '../lib/data';
import { matches } from '../lib/format';

/**
 * Sélecteur d'articles rattachés au stock — commun aux cahiers et aux bons de
 * livraison : piocher dans le stock quand l'article y figure, taper un libellé
 * libre sinon. On ne bloque jamais une saisie parce qu'une référence manque
 * au catalogue.
 */

const TYPE_LABEL: Record<ProductType, string> = {
  consumable: 'Consommable',
  mixLiquid: 'Mix liquide',
  mixPowder: 'Mix poudre',
  machine: 'Machine',
  part: 'Pièce détachée',
};

/** Natures proposées en tête selon le contexte : pièces au SAV, mix et
 *  consommables dans les commandes et les livraisons. */
const PREFERRED_TYPES: Record<'part' | 'consumable', ProductType[]> = {
  part: ['part', 'machine'],
  consumable: ['consumable', 'mixLiquid', 'mixPowder'],
};

export function ItemPicker({
  label,
  preferredType,
  items,
  onChange,
}: {
  label: string;
  /** Nature mise en avant : pièces détachées en SAV, consommables ailleurs. */
  preferredType: ProductType;
  items: RegisterItem[];
  onChange: (items: RegisterItem[]) => void;
}) {
  const { data: products } = useProducts();
  const [query, setQuery] = useState('');

  const productIndex = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Les articles de la nature attendue d'abord, mais tout le stock reste
  // accessible : une commande peut mélanger un consommable et une pièce.
  const results = useMemo(() => {
    if (!query.trim()) return [];
    const taken = new Set(items.map((i) => i.productId).filter(Boolean));
    return products
      .filter((p) => !p.archived && !taken.has(p.id))
      .filter((p) => matches(`${p.sku} ${p.name} ${p.category ?? ''}`, query))
      .sort((a, b) => {
        const preferred = PREFERRED_TYPES[preferredType as 'part' | 'consumable'] ?? [preferredType];
        const rank = (p: Product) => (preferred.includes(p.type ?? 'consumable') ? 0 : 1);
        return rank(a) - rank(b) || a.name.localeCompare(b.name, 'fr');
      })
      .slice(0, 6);
  }, [products, query, items, preferredType]);

  const add = (item: RegisterItem) => {
    onChange([...items, item]);
    setQuery('');
  };

  return (
    <Field
      label={label}
      hint="Piochez dans le stock, ou tapez un libellé libre si l’article n’y figure pas encore"
    >
      <div className="col" style={{ gap: 8 }}>
        {items.length > 0 && (
          <div className="list">
            {items.map((item, index) => {
              const product = item.productId ? productIndex.get(item.productId) : undefined;
              return (
                <div key={`${item.productId ?? item.label}-${index}`} className="list__item">
                  <NumberInput
                    value={item.qty}
                    onValueChange={(v) => {
                      const next = [...items];
                      next[index] = { ...item, qty: Math.max(1, Math.round(v)) };
                      onChange(next);
                    }}
                    style={{ width: 76 }}
                  />
                  <span className="truncate">{item.label}</span>
                  {product ? (
                    <Badge tone="badge--blue">
                      {TYPE_LABEL[product.type]} · {product.qtyOnHand} en stock
                    </Badge>
                  ) : (
                    <Badge>hors stock</Badge>
                  )}
                  <div className="spacer" />
                  <IconButton
                    title="Retirer"
                    danger
                    onClick={() => onChange(items.filter((_, i) => i !== index))}
                  >
                    <Icons.close size={14} />
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}

        <Input
          placeholder="Rechercher dans le stock…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {results.length > 0 && (
          <div className="list">
            {results.map((product) => (
              <div
                key={product.id}
                className="list__item"
                style={{ cursor: 'default' }}
                onClick={() => add({ productId: product.id, label: product.name, qty: 1 })}
              >
                <span className="mono tiny muted" style={{ minWidth: 78 }}>
                  {product.sku}
                </span>
                <span className="truncate">{product.name}</span>
                <div className="spacer" />
                <Badge tone={(PREFERRED_TYPES[preferredType as 'part' | 'consumable'] ?? []).includes(product.type ?? 'consumable') ? 'badge--blue' : ''}>
                  {TYPE_LABEL[product.type]}
                </Badge>
                <span className="tiny muted">{product.qtyOnHand} en stock</span>
              </div>
            ))}
          </div>
        )}

        {query.trim() && !results.some((p) => p.name.toLowerCase() === query.trim().toLowerCase()) && (
          <Button
            size="sm"
            icon={<Icons.plus size={13} />}
            onClick={() => add({ label: query.trim(), qty: 1 })}
          >
            Ajouter « {query.trim()} » hors stock
          </Button>
        )}

        {!products.length && (
          <p className="tiny muted" style={{ margin: 0 }}>
            Votre stock est vide : ajoutez vos consommables, machines et pièces depuis l’onglet
            Stock pour les retrouver ici.
          </p>
        )}
      </div>
    </Field>
  );
}
