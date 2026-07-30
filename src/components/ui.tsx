import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/* ================================================================== */
/* Icônes (SVG en ligne, trait fin façon SF Symbols)                   */
/* ================================================================== */

type IconProps = { size?: number; className?: string };

const svg = (path: ReactNode, viewBox = '0 0 24 24') =>
  function Icon({ size = 16, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  };

export const Icons = {
  dashboard: svg(<><rect x="3" y="3" width="7.5" height="8.5" rx="2" /><rect x="13.5" y="3" width="7.5" height="5" rx="2" /><rect x="13.5" y="11" width="7.5" height="10" rx="2" /><rect x="3" y="14.5" width="7.5" height="6.5" rx="2" /></>),
  documents: svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></>),
  clients: svg(<><path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" /><circle cx="9" cy="7" r="3.4" /><path d="M22 20v-1.5a4 4 0 0 0-3-3.87" /><path d="M16 3.6a4 4 0 0 1 0 7" /></>),
  stock: svg(<><path d="M20.5 7.3 12 2.6 3.5 7.3v9.4L12 21.4l8.5-4.7z" /><path d="M3.6 7.2 12 12l8.4-4.8M12 12v9.4" /></>),
  routes: svg(<><circle cx="6" cy="18.5" r="2.5" /><circle cx="18" cy="5.5" r="2.5" /><path d="M15.5 5.5H9a3 3 0 0 0 0 6h6a3 3 0 0 1 0 6H8.5" /></>),
  settings: svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10.6 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>),
  search: svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  plus: svg(<><path d="M12 5v14M5 12h14" /></>),
  close: svg(<><path d="M18 6 6 18M6 6l12 12" /></>),
  refresh: svg(<><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>),
  folder: svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>),
  download: svg(<><path d="M12 3v12" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M4 20h16" /></>),
  upload: svg(<><path d="M12 21V9" /><path d="m7.5 13.5 4.5-4.5 4.5 4.5" /><path d="M4 4h16" /></>),
  pin: svg(<><path d="M12 17v5" /><path d="M9 3h6l-1 6 3.5 3v2h-11v-2L10 9z" /></>),
  trash: svg(<><path d="M4 7h16" /><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" /><path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" /><path d="M10 11.5v6M14 11.5v6" /></>),
  edit: svg(<><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" /><path d="M14.5 6.5 17.5 9.5" /></>),
  check: svg(<><path d="m4.5 12.5 5 5 10-11" /></>),
  chevron: svg(<><path d="m9 6 6 6-6 6" /></>),
  grip: svg(<><circle cx="9" cy="6" r="1.2" fill="currentColor" /><circle cx="9" cy="12" r="1.2" fill="currentColor" /><circle cx="9" cy="18" r="1.2" fill="currentColor" /><circle cx="15" cy="6" r="1.2" fill="currentColor" /><circle cx="15" cy="12" r="1.2" fill="currentColor" /><circle cx="15" cy="18" r="1.2" fill="currentColor" /></>),
  route: svg(<><path d="M12 21s7-6.4 7-11.4A7 7 0 0 0 5 9.6C5 14.6 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></>),
  fuel: svg(<><path d="M4 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16" /><path d="M3 21h11" /><path d="M13 9h3.5a2 2 0 0 1 2 2v6a1.6 1.6 0 0 0 3.2 0V10l-2.6-3" /><path d="M5.5 8.5h6" /></>),
  phone: svg(<><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M11 18.5h2" /></>),
  warning: svg(<><path d="M12 3.5 22 20H2z" /><path d="M12 10v4.5M12 17.5v.01" /></>),
  link: svg(<><path d="M10 13a4.5 4.5 0 0 0 6.5.4l2.5-2.5a4.6 4.6 0 0 0-6.5-6.5L11 5.9" /><path d="M14 11a4.5 4.5 0 0 0-6.5-.4L5 13.1a4.6 4.6 0 0 0 6.5 6.5l1.5-1.5" /></>),
  clock: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.2 2" /></>),
  euro: svg(<><path d="M17.5 6.5A6.5 6.5 0 0 0 7 11.8v.4a6.5 6.5 0 0 0 10.5 5.3" /><path d="M4.5 10.5h8M4.5 13.5h8" /></>),
  box: svg(<><path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></>),
  sparkle: svg(<><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="m6 6 2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></>),
};

/* ================================================================== */
/* Boutons et champs                                                   */
/* ================================================================== */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  icon?: ReactNode;
  block?: boolean;
  loading?: boolean;
};

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  block,
  loading,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    variant !== 'default' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : '',
    block ? 'btn--block' : '',
    !children ? 'btn--icon' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spin"><Icons.refresh size={size === 'sm' ? 12 : 14} /></span> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  title,
  active,
  danger,
  onClick,
  children,
  disabled,
}: {
  title: string;
  active?: boolean;
  danger?: boolean;
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`iconbtn ${active ? 'iconbtn--active' : ''} ${danger ? 'iconbtn--danger' : ''}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  style,
}: {
  label?: string;
  hint?: string;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="field" style={style}>
      {label && <label className="field__label">{label}</label>}
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input className={`input ${className}`} {...rest} />;
}

export function NumberInput({
  value,
  onValueChange,
  step = 1,
  min,
  suffix,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number | undefined;
  onValueChange: (value: number) => void;
  suffix?: string;
}) {
  // Saisie libre pendant la frappe (virgule décimale acceptée), valeur numérique à la sortie.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined || Number.isNaN(value) ? '' : String(value).replace('.', ','));

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input
        className="input input--number"
        inputMode="decimal"
        value={shown}
        step={step}
        min={min}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) {
            const parsed = Number(draft.replace(/\s/g, '').replace(',', '.'));
            onValueChange(Number.isFinite(parsed) ? parsed : 0);
            setDraft(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        style={suffix ? { paddingRight: 34 } : undefined}
        {...rest}
      />
      {suffix && (
        <span
          className="tiny muted"
          style={{ position: 'absolute', right: 10, pointerEvents: 'none' }}
        >
          {suffix}
        </span>
      )}
    </div>
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', children, ...rest } = props;
  return (
    <select className={`select ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <textarea className={`textarea ${className}`} {...rest} />;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Rechercher…',
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className="search" style={style}>
      <span className="search__icon">
        <Icons.search size={14} />
      </span>
      <input
        className="input"
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button className="search__clear" onClick={() => onChange('')} title="Effacer" type="button">
          <Icons.close size={13} />
        </button>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track">
        <span className="switch__thumb" />
      </span>
      {label && <span style={{ fontSize: 13 }}>{label}</span>}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({
  tone = '',
  children,
}: {
  tone?: string;
  children: ReactNode;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/* ================================================================== */
/* Conteneurs                                                          */
/* ================================================================== */

export function Card({
  title,
  subtitle,
  actions,
  children,
  padded = true,
  style,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <section className="card" style={style}>
      {(title || actions) && (
        <header className="card__header">
          <div>
            {title && <div className="card__title">{title}</div>}
            {subtitle && <div className="card__subtitle">{subtitle}</div>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'card__body' : ''}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = '',
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: '' | 'accent' | 'warn' | 'danger' | 'ok';
  icon?: ReactNode;
}) {
  return (
    <div className={`stat ${tone ? `stat--${tone}` : ''}`}>
      <div className="stat__label">
        {icon}
        {label}
      </div>
      <div className="stat__value">{value}</div>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  );
}

export function EmptyState({
  icon = '📄',
  title,
  text,
  action,
}: {
  icon?: ReactNode;
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <div className="empty__title">{title}</div>
      {text && <p className="empty__text">{text}</p>}
      {action}
    </div>
  );
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true">
        <header className="modal__header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal__title">{title}</div>
            {subtitle && <div className="modal__subtitle">{subtitle}</div>}
          </div>
          <IconButton title="Fermer" onClick={onClose}>
            <Icons.close size={16} />
          </IconButton>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}

/** Boîte de confirmation — remplace `window.confirm`, indisponible en pratique dans Electron. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmer',
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Annuler</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>{message}</div>
    </Modal>
  );
}

/* ================================================================== */
/* Notifications                                                       */
/* ================================================================== */

export interface Toast {
  id: string;
  title: string;
  text?: string;
  tone?: 'info' | 'success' | 'error' | 'warn';
}

const ToastContext = createContext<{
  push: (toast: Omit<Toast, 'id'>) => void;
}>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = `t${counter.current++}`;
    setToasts((list) => [...list, { ...toast, id }]);
    const delay = toast.tone === 'error' ? 8000 : 4200;
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), delay);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone ? `toast--${toast.tone}` : ''}`}>
            <div className="toast__body">
              <div className="toast__title">{toast.title}</div>
              {toast.text && <div className="toast__text">{toast.text}</div>}
            </div>
            <IconButton
              title="Fermer"
              onClick={() => setToasts((list) => list.filter((t) => t.id !== toast.id))}
            >
              <Icons.close size={13} />
            </IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* ================================================================== */
/* Divers                                                              */
/* ================================================================== */

export function Spinner({ size = 15 }: { size?: number }) {
  return (
    <span className="spin" style={{ color: 'var(--text-tertiary)' }}>
      <Icons.refresh size={size} />
    </span>
  );
}

/** Valeur retardée : évite de lancer une requête à chaque frappe. */
export function useDebounced<T>(value: T, delay = 260): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useAutoId(prefix: string): string {
  const id = useId();
  return `${prefix}${id}`;
}
