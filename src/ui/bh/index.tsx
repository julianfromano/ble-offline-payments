/**
 * BH Design System — componentes portados del bh-claude-toolkit (Figma retail).
 * Solo los componentes usados por la demo; tokens en tokens.css.
 */
import type { ReactNode, ChangeEventHandler, InputHTMLAttributes } from 'react';
import './tokens.css';
import './BhButton.css';
import './BhCard.css';
import './BhTextField.css';
import './BhChip.css';
import './BhAlert.css';
import './BhHeader.css';
import logoRetail from './assets/logo-bh.svg';

// ── Button ──────────────────────────────────────────────────────────────────
export function BhButton({
  variant = 'primary',
  size = 'regular',
  disabled = false,
  onClick,
  type = 'button',
  children,
}: {
  variant?: 'primary' | 'secondary' | 'tertiary';
  size?: 'regular' | 'small';
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      className={`bh-btn bh-btn--${variant} bh-btn--${size}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="bh-btn__label">{children}</span>
    </button>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────
export function BhCard({
  orientation = 'vertical',
  title,
  children,
  className = '',
}: {
  orientation?: 'vertical' | 'horizontal';
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`bh-card bh-card--${orientation} ${className}`}>
      {title && <p className="bh-card__title">{title}</p>}
      <div className="bh-card__content">{children}</div>
    </div>
  );
}

// ── TextField ───────────────────────────────────────────────────────────────
export function BhTextField({
  label,
  helper,
  state = 'enabled',
  value,
  onChange,
  id,
  ...rest
}: {
  label?: string;
  helper?: string;
  state?: 'enabled' | 'danger' | 'success' | 'disabled';
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  id: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'id'>) {
  return (
    <div className={`bh-field bh-field--${state}`}>
      {label && <label className="bh-label" htmlFor={id}>{label}</label>}
      <input
        id={id}
        className="bh-input"
        disabled={state === 'disabled'}
        value={value}
        onChange={onChange}
        {...rest}
      />
      {helper && (
        <span className={`bh-helper ${state === 'danger' ? 'error' : state === 'success' ? 'success' : ''}`}>
          {helper}
        </span>
      )}
    </div>
  );
}

// ── Chip ────────────────────────────────────────────────────────────────────
export function BhChip({
  severity = 'info',
  children,
}: {
  severity?: 'info' | 'special' | 'danger' | 'warning' | 'success' | 'neutral';
  children: ReactNode;
}) {
  return <span className={`bh-chip bh-chip--${severity}`}>{children}</span>;
}

// ── Alert ───────────────────────────────────────────────────────────────────
export function BhAlert({
  severity = 'info',
  title,
  description,
}: {
  severity?: 'info' | 'error' | 'warning' | 'success';
  title?: string;
  description?: ReactNode;
}) {
  return (
    <div className={`bh-alert bh-alert--${severity}`} role="alert">
      <div className="bh-alert__body">
        {title && <p className="bh-alert__title">{title}</p>}
        {description && <p className="bh-alert__description">{description}</p>}
      </div>
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────
export function BhHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="bh-header bh-header--retail">
      <img src={logoRetail} alt="Banco Hipotecario" className="bh-header__logo" />
      {actions && <div className="bh-header__actions">{actions}</div>}
    </header>
  );
}
