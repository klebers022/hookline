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
} from '../components/ui';
import { formatDate } from '../format';

const TABS = [
  { status: 'dead', label: 'Dead' },
  { status: 'retrying', label: 'Retrying' },
] as const;

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
      <PageHeader title="Failed deliveries" />
      <div className="mb-4 flex gap-1" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            role="tab"
            aria-selected={status === tab.status}
            onClick={() => setParams({ status: tab.status })}
            className={`rounded-md px-3 py-1 text-sm ${
              status === tab.status
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-200'
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
        <Empty>Nothing here.</Empty>
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
              <td className="px-4 py-2 font-medium">
                <Link
                  to={`/deliveries/${delivery.id}`}
                  className="hover:underline"
                >
                  {delivery.event_type}
                </Link>
              </td>
              <td className="px-4 py-2 break-all text-slate-600">
                {delivery.endpoint_url}
              </td>
              <td className="px-4 py-2">{delivery.attempt_count}</td>
              <td className="px-4 py-2 text-slate-600">
                {formatDate(
                  status === 'dead'
                    ? delivery.created_at
                    : delivery.next_attempt_at,
                )}
              </td>
              <td className="px-4 py-2">
                {status === 'dead' && <RetryButton deliveryId={delivery.id} />}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <LoadMore {...list} />
    </>
  );
}
