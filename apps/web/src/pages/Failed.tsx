import { Link, useSearchParams } from 'react-router';
import { usePagedList } from '../api/queries';
import type { Delivery } from '../api/types';
import { LoadMore } from '../components/LoadMore';
import { RetryButton } from '../components/RetryButton';
import {
  Empty,
  ErrorMessage,
  Loading,
  PageHeader,
  Table,
  Time,
  Url,
} from '../components/ui';

const TABS = [
  { status: 'dead', label: 'Dead' },
  { status: 'retrying', label: 'Retrying' },
] as const;

const EMPTY = {
  dead: 'No dead deliveries. Every delivery succeeded or is still being tried.',
  retrying: 'No delivery is waiting for another try.',
};

// Dead deliveries ran out of attempts; retrying ones are waiting for the
// next. Both are where someone looks when an endpoint misbehaves.
export function Failed() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') === 'retrying' ? 'retrying' : 'dead';
  const list = usePagedList<Delivery>(
    ['deliveries', status],
    `/v1/deliveries?status=${status}&limit=25`,
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
            'Attempts',
            status === 'dead' ? 'Created' : 'Next attempt',
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
              <td className="font-mono text-[13px]">
                {delivery.attempt_count}
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
