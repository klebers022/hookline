import { Link, useSearchParams } from 'react-router';
import { REFRESH_MS, usePagedList } from '../api/queries';
import type { Delivery, Endpoint } from '../api/types';
import { LoadMore } from '../components/LoadMore';
import { RetryButton } from '../components/RetryButton';
import { RoutePips } from '../components/Route';
import {
  Empty,
  ErrorMessage,
  Loading,
  PageHeader,
  Table,
  Time,
  Url,
} from '../components/ui';
import { formatTime } from '../format';
import { heldUntil } from '../route';

const TABS = [
  { status: 'dead', label: 'Dead' },
  { status: 'retrying', label: 'Retrying' },
] as const;

const EMPTY = {
  dead: 'No dead deliveries. Every delivery succeeded or is still being tried.',
  retrying: 'No delivery is waiting for another try.',
};

// Dead deliveries ran out of attempts; retrying ones are waiting for the
// next. Both are where someone looks when an endpoint misbehaves, so the
// list keeps itself current, like the details pages do.
export function Failed() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') === 'retrying' ? 'retrying' : 'dead';
  const list = usePagedList<Delivery>(
    ['deliveries', status],
    `/v1/deliveries?status=${status}&limit=25`,
    REFRESH_MS,
  );

  return (
    <>
      <PageHeader
        title="Failed deliveries"
        description="Deliveries that gave up, and those still waiting for their next try."
      />
      <div
        role="tablist"
        className="mb-[18px] inline-flex gap-0.5 rounded-lg bg-rule-soft p-[3px]"
      >
        {TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            role="tab"
            aria-selected={status === tab.status}
            onClick={() => setParams({ status: tab.status })}
            className={`rounded-md px-3.5 py-[7px] text-sm font-medium ${
              status === tab.status
                ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(24_32_58/0.12)]'
                : 'text-ink-2 hover:text-ink'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <PausedEndpoints />
      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorMessage error={list.error} />
      ) : list.rows.length === 0 ? (
        <Empty>{EMPTY[status]}</Empty>
      ) : (
        <Table
          head={[
            'Event',
            'Endpoint',
            'Tries',
            status === 'dead' ? 'Created' : 'Next try',
            '',
          ]}
        >
          {list.rows.map((delivery) => (
            <tr key={delivery.id}>
              <td className="font-semibold">
                <Link
                  to={`/deliveries/${delivery.id}`}
                  className="hover:underline"
                >
                  {delivery.event_type}
                </Link>
              </td>
              <td>
                <Url url={delivery.endpoint_url} />
              </td>
              <td>
                <RoutePips delivery={delivery} />
              </td>
              <td className="whitespace-nowrap text-ink-2">
                <Time
                  value={
                    status === 'dead'
                      ? delivery.created_at
                      : delivery.next_attempt_at
                  }
                />
              </td>
              <td className="text-right">
                {status === 'dead' && (
                  <RetryButton deliveryId={delivery.id} size="sm" />
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <LoadMore {...list} />
    </>
  );
}

// Endpoints whose circuit breaker is open: their deliveries wait without
// using up tries, which explains a retrying list that does not move.
function PausedEndpoints() {
  const endpoints = usePagedList<Endpoint>(
    ['endpoints', 'paused'],
    '/v1/endpoints?limit=100',
    REFRESH_MS,
  );
  const paused = endpoints.rows.flatMap((endpoint) => {
    const until = heldUntil(endpoint.circuit_open_until);
    return until ? [{ endpoint, until }] : [];
  });
  if (paused.length === 0) {
    return null;
  }
  return (
    <ul className="mb-5 space-y-2">
      {paused.map(({ endpoint, until }) => (
        <li
          key={endpoint.id}
          className="flex flex-col gap-2 rounded-[10px] border border-wait/30 bg-wait-wash px-4 py-3.5 text-sm sm:flex-row sm:items-baseline sm:gap-3"
        >
          <span className="font-semibold whitespace-nowrap text-wait">
            Paused until {formatTime(until)}
          </span>
          <span>
            <Url url={endpoint.url} /> failed {endpoint.consecutive_failures}{' '}
            times in a row, so Hookline is holding its deliveries. They do not
            use up their tries.
          </span>
        </li>
      ))}
    </ul>
  );
}
