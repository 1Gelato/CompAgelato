import { useEffect, useRef, useState } from 'react';
import type { Address, AddressSuggestion } from '@shared/types';
import { Icons, useDebounced } from './ui';

/**
 * Champ d'adresse avec recherche intelligente.
 * Les propositions viennent de la Base Adresse Nationale (service public,
 * sans clé d'API) ; la sélection renseigne aussi les coordonnées GPS, qui
 * servent ensuite au calcul d'itinéraire.
 */
export function AddressInput({
  value,
  onChange,
  onSelect,
  placeholder = 'Commencez à taper une adresse…',
  autoFocus,
  near,
  onEnterWithoutSelection,
}: {
  value: Address;
  onChange: (address: Address) => void;
  /**
   * Appelé uniquement quand une proposition est retenue — donc avec des
   * coordonnées GPS. Permet de n'enregistrer qu'à ce moment-là, plutôt qu'à
   * chaque frappe.
   */
  onSelect?: (address: Address) => void;
  placeholder?: string;
  autoFocus?: boolean;
  near?: { lat: number; lon: number };
  onEnterWithoutSelection?: () => void;
}) {
  const [query, setQuery] = useState(value.label ?? '');
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [touched, setTouched] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounced = useDebounced(query, 260);

  // Synchronise l'affichage quand la valeur change depuis l'extérieur.
  useEffect(() => {
    if (!touched) setQuery(value.label ?? '');
  }, [value.label, touched]);

  useEffect(() => {
    if (!touched || debounced.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    window.api.geo
      .autocomplete(debounced, near ? { near } : undefined)
      .then((results) => {
        if (cancelled) return;
        setSuggestions(results);
        setActiveIndex(0);
        setOpen(results.length > 0);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, touched, near]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const select = (suggestion: AddressSuggestion) => {
    const address: Address = {
      label: suggestion.label,
      street: suggestion.street,
      postcode: suggestion.postcode,
      city: suggestion.city,
      country: 'France',
      lat: suggestion.lat,
      lon: suggestion.lon,
    };
    setQuery(suggestion.label);
    setTouched(false);
    setOpen(false);
    setSuggestions([]);
    onChange(address);
    onSelect?.(address);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || !suggestions.length) {
      if (e.key === 'Enter') onEnterWithoutSelection?.();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      select(suggestions[activeIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const noCoords = Boolean(value.label) && typeof value.lat !== 'number';

  return (
    <div className="autocomplete" ref={containerRef}>
      <div className="search">
        <span className="search__icon">
          <Icons.route size={14} />
        </span>
        <input
          className="input"
          value={query}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQuery(e.target.value);
            setTouched(true);
            // Une adresse tapée à la main reste utilisable, sans coordonnées.
            onChange({ ...value, label: e.target.value, lat: undefined, lon: undefined });
          }}
          onFocus={() => suggestions.length && setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {loading && (
          <span className="search__clear spin">
            <Icons.refresh size={13} />
          </span>
        )}
      </div>

      {open && (
        <div className="autocomplete__list">
          {suggestions.map((suggestion, index) => (
            <div
              key={`${suggestion.label}-${index}`}
              className="autocomplete__item"
              data-active={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                select(suggestion);
              }}
            >
              <span className="autocomplete__label">{suggestion.label}</span>
              {suggestion.context && <span className="autocomplete__sub">{suggestion.context}</span>}
            </div>
          ))}
        </div>
      )}

      {!open && touched && !loading && debounced.trim().length >= 3 && suggestions.length === 0 && (
        <div className="field__hint" style={{ marginTop: 4 }}>
          Aucune adresse trouvée pour cette saisie. Essayez « numéro rue ville » (par exemple
          « 27 rue Jacques Daguerre Saint-Nazaire »).
        </div>
      )}

      {noCoords && !open && (
        <div className="field__hint" style={{ marginTop: 4, color: 'var(--orange)' }}>
          Adresse saisie mais non retenue dans la liste : cliquez sur une proposition pour
          enregistrer sa position et l’utiliser dans le calcul de trajet.
        </div>
      )}
    </div>
  );
}
