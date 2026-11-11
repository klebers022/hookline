import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import type { DeliveryStatus, EndpointStatus } from '../api/types';
import { formatDate, formatRelative } from '../format';

// Each status has its own colour and its own shape (dot, ring, diamond), so
// it reads without telling the colours apart.
const STATUS_STYLES: Record<DeliveryStatus | EndpointStatus, string> = {
  pending: 'bg-idle-wash text-idle before:rounded-full before:bg-current',
  retrying:
    'bg-wait-wash text-wait before:rounded-full before:border-2 before:border-current',
  succeeded: 'bg-ok-wash text-ok before:rounded-full before:bg-current',
  dead: 'bg-bad-wash text-bad before:scale-90 before:rotate-45 before:rounded-[2px] before:bg-current',
  active: 'bg-ok-wash text-ok before:rounded-full before:bg-current',
  disabled: 'bg-idle-wash text-idle before:rounded-full before:bg-current',
};

export function StatusBadge({
  status,
}: {
  status: DeliveryStatus | EndpointStatus;
}) {
  return (
    <span
      className={`inline-flex items-center gap-[7px] rounded-full py-[3px] pr-2.5 pl-2 text-[13px] font-semibold whitespace-nowrap before:size-2 before:content-[''] ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

export function ErrorMessage({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError
      ? `${error.title}${error.detail ? `: ${error.detail}` : ''}`
      : error instanceof Error
        ? error.message
        : 'Something went wrong';
  return (
    <p
      role="alert"
      className="rounded-lg border border-bad/30 bg-bad-wash px-3.5 py-2.5 text-sm text-ink"
    >
      {message}
    </p>
  );
}

export function Loading() {
  return <p className="py-6 text-sm text-ink-3">Loading…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[10px] border border-dashed border-rule px-4 py-10 text-center text-sm text-ink-2">
      {children}
    </p>
  );
}

export function PageHeader({
  title,
  description,
  crumbs,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  crumbs?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {crumbs && <div className="mb-1.5 text-sm text-ink-3">{crumbs}</div>}
        <h1>{title}</h1>
        {description && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-[18px] gap-y-1.5 text-sm text-ink-2">
            {description}
          </div>
        )}
      </div>
      {children && <div className="flex gap-2">{children}</div>}
    </div>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'md' | 'sm';
};

const BUTTON_STYLES = {
  primary: 'border-stamp bg-stamp text-stamp-ink hover:brightness-110',
  secondary: 'border-rule bg-surface text-ink hover:border-ink-3',
  quiet:
    'border-transparent bg-transparent text-ink-2 hover:bg-rule-soft hover:text-ink',
  danger: 'border-transparent bg-transparent text-bad hover:bg-bad-wash',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: ButtonProps) {
  const sizing =
    size === 'sm' ? 'px-[11px] py-[7px] text-[13px]' : 'px-3.5 py-2.5 text-sm';
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-md border leading-none font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45 ${sizing} ${BUTTON_STYLES[variant]} ${className}`}
      {...props}
    />
  );
}

// A list is one surface with hairline rows, not a card per row.
export function Table({
  head,
  children,
}: {
  head: string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-rule bg-surface">
      <table className="min-w-full border-collapse text-left text-sm [&_td]:border-b [&_td]:border-rule-soft [&_td]:px-[18px] [&_td]:py-3.5 [&_td]:align-middle [&_tbody_tr:last-child_td]:border-b-0">
        <thead>
          <tr>
            {head.map((label, index) => (
              <th
                key={`${label}-${index}`}
                scope="col"
                className="border-b border-rule px-[18px] py-3 text-[13px] font-medium whitespace-nowrap text-ink-3"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_tr:hover]:bg-code">{children}</tbody>
      </table>
    </div>
  );
}

// The host stands out and the path recedes, which is how people scan URLs.
export function Url({
  url,
  className = 'text-[13px] tracking-[-0.01em]',
}: {
  url: string;
  className?: string;
}) {
  let host = url;
  let rest = '';
  try {
    const parsed = new URL(url);
    host = `${parsed.protocol === 'https:' ? '' : `${parsed.protocol}//`}${parsed.host}`;
    rest = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
  } catch {
    // Not a URL the browser understands: show it as it is.
  }
  return (
    <span
      title={url}
      className={`font-mono [overflow-wrap:anywhere] ${className}`}
    >
      <span className="text-ink">{host}</span>
      <span className="text-ink-3">{rest}</span>
    </span>
  );
}

// "2 minutes ago", with the exact moment on hover.
export function Time({ value }: { value: string | null }) {
  if (!value) {
    return <span className="text-ink-3">—</span>;
  }
  return (
    <time dateTime={value} title={formatDate(value)}>
      {formatRelative(value)}
    </time>
  );
}

const inputBase =
  'block w-full rounded-md border border-rule bg-surface px-3 py-2.5 text-ink placeholder:text-ink-3 focus:border-stamp focus:ring-3 focus:ring-stamp-wash focus:outline-none';
export const inputClass = `${inputBase} text-[15px]`;
// For what a machine reads: URLs, event types, keys, JSON.
export const monoInputClass = `${inputBase} font-mono text-[13px]`;

export const formClass =
  'mb-6 space-y-4 rounded-[10px] border border-rule bg-surface p-[22px]';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint && (
        <small className="mt-1.5 block text-[13px] text-ink-3">{hint}</small>
      )}
    </label>
  );
}

export const codeClass =
  'overflow-x-auto rounded-md border border-rule-soft bg-code px-3.5 py-3 font-mono text-[13px] leading-relaxed text-ink';

// An on/off control that says its state to screen readers (role="switch").
export function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors after:absolute after:top-[3px] after:left-[3px] after:size-3.5 after:rounded-full after:bg-surface after:transition-transform after:content-[''] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none motion-reduce:after:transition-none ${
        checked ? 'bg-ok after:translate-x-4' : 'bg-rule'
      }`}
    />
  );
}
