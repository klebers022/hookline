import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import type { DeliveryStatus, EndpointStatus } from '../api/types';

const STATUS_STYLES: Record<DeliveryStatus | EndpointStatus, string> = {
  pending: 'bg-slate-100 text-slate-700 ring-slate-300',
  retrying: 'bg-amber-50 text-amber-800 ring-amber-300',
  succeeded: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  dead: 'bg-red-50 text-red-800 ring-red-300',
  active: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  disabled: 'bg-slate-100 text-slate-600 ring-slate-300',
};

export function StatusBadge({
  status,
}: {
  status: DeliveryStatus | EndpointStatus;
}) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_STYLES[status]}`}
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
      className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
    >
      {message}
    </p>
  );
}

export function Loading() {
  return <p className="text-sm text-slate-500">Loading…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
      {children}
    </p>
  );
}

export function PageHeader({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      {children && <div className="flex gap-2">{children}</div>}
    </div>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
};

const BUTTON_STYLES = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700',
  secondary: 'bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50',
  danger: 'bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_STYLES[variant]} ${className}`}
      {...props}
    />
  );
}

export function Table({
  head,
  children,
}: {
  head: string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200">
      <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
        <thead className="bg-slate-50 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
          <tr>
            {head.map((label) => (
              <th key={label} scope="col" className="px-4 py-2">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

export const inputClass =
  'block w-full rounded-md border-0 px-3 py-1.5 text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-slate-900';
