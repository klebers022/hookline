import type { CSSProperties } from 'react';
import type { EventDelivery } from '../api/types';
import {
  pipsLabel,
  routePips,
  type Pip,
  type Stop,
  type StopKind,
  type Summary,
} from '../route';

const NODE: Record<StopKind, string> = {
  failed: 'border-bad bg-bad',
  succeeded: 'border-ok bg-ok',
  next: 'border-wait bg-surface',
  held: 'border-wait border-dashed bg-surface',
};

const RESULT: Record<StopKind, string> = {
  failed: 'text-bad',
  succeeded: 'text-ok',
  next: 'text-wait',
  held: 'text-wait',
};

// The mark inside a node, so a stop reads without its colour.
function NodeMark({ kind }: { kind: StopKind }) {
  switch (kind) {
    case 'failed':
      return <span className="h-[3px] w-[9px] rounded-sm bg-surface" />;
    case 'succeeded':
      return (
        <span className="mb-0.5 h-[5px] w-[9px] -rotate-45 border-b-[2.5px] border-l-[2.5px] border-surface" />
      );
    case 'next':
      return (
        <span className="size-[9px] rounded-full bg-wait motion-safe:animate-[beat_1.6s_ease-in-out_infinite]" />
      );
    case 'held':
      return (
        <span className="flex gap-[2px]">
          <span className="h-[9px] w-[3px] rounded-sm bg-wait" />
          <span className="h-[9px] w-[3px] rounded-sm bg-wait" />
        </span>
      );
  }
}

// The line from a stop to the next one: red after a failure, fading into
// grey when what follows has not happened yet.
function lineClass(from: StopKind, to: StopKind | undefined): string {
  if (!to) {
    return 'hidden';
  }
  if (to === 'next' || to === 'held') {
    return 'from-bad to-rule bg-linear-to-b sm:bg-linear-to-r';
  }
  return from === 'failed' ? 'bg-bad' : 'bg-ok';
}

export function Route({ summary, stops }: { summary: Summary; stops: Stop[] }) {
  return (
    <section
      aria-label="Delivery route"
      className="mb-7 rounded-[10px] border border-rule bg-surface px-[22px] pt-6 pb-5 sm:px-[26px]"
    >
      <h2>{summary.title}</h2>
      <p className="mt-1 mb-6 max-w-[64ch] text-sm text-ink-2">
        {summary.text}
      </p>
      {stops.length > 0 && (
        <ol
          style={{ '--n': stops.length } as CSSProperties}
          className="grid grid-cols-1 sm:grid-cols-[repeat(var(--n),minmax(0,1fr))]"
        >
          {stops.map((stop, index) => (
            <li
              key={index}
              className="relative min-h-[58px] pb-[18px] pl-10 sm:min-h-0 sm:pt-[34px] sm:pb-0 sm:pl-0"
            >
              <span
                aria-hidden="true"
                className={`absolute top-[25px] bottom-0 left-[11px] w-[3px] sm:top-[11px] sm:right-0 sm:bottom-auto sm:left-3 sm:h-[3px] sm:w-auto ${lineClass(stop.kind, stops[index + 1]?.kind)}`}
              />
              <span
                aria-hidden="true"
                className={`absolute top-0 left-0 grid size-[25px] place-items-center rounded-full border-[3px] ${NODE[stop.kind]}`}
              >
                <NodeMark kind={stop.kind} />
              </span>
              <div className="text-[13px] text-ink-3">{stop.label}</div>
              <div
                className={`mt-0.5 font-mono text-lg font-medium tracking-[-0.02em] ${RESULT[stop.kind]}`}
              >
                {stop.result}
              </div>
              <div className="pr-2.5 text-[13px] text-ink-2">{stop.detail}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const PIP: Record<Pip, string> = {
  failed: 'bg-bad',
  succeeded: 'bg-ok',
  next: 'shadow-[inset_0_0_0_1.5px_var(--wait)]',
};

// The route in miniature, with its meaning in words beside it.
export function RoutePips({ delivery }: { delivery: EventDelivery }) {
  const pips = routePips(delivery);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span aria-hidden="true" className="inline-flex gap-[3px]">
        {pips.map((pip, index) => (
          <i key={index} className={`h-1.5 w-3.5 rounded-[2px] ${PIP[pip]}`} />
        ))}
      </span>
      <span className="text-[13px] text-ink-3">{pipsLabel(delivery)}</span>
    </span>
  );
}
