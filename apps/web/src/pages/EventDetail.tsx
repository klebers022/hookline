import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { REFRESH_MS } from '../api/queries';
import { isFinal, type EventDetail as Detail } from '../api/types';
import { useApi } from '../auth';
import { RetryButton } from '../components/RetryButton';
import {
  Empty,
  ErrorMessage,
  Loading,
  PageHeader,
  StatusBadge,
  Table,
} from '../components/ui';
import { formatDate, formatJson } from '../format';

export function EventDetail() {
  const { id } = useParams();
  const api = useApi();
  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.get<Detail>(`/v1/events/${id}`),
    refetchInterval: (query) =>
      query.state.data?.deliveries.every((item) => isFinal(item.status))
        ? false
        : REFRESH_MS,
  });

  if (event.isPending) {
    return <Loading />;
  }
  if (event.error) {
    return <ErrorMessage error={event.error} />;
  }
  const { data } = event;
  return (
    <>
      <PageHeader title={data.type} />
      <dl className="mb-6 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-slate-500">ID</dt>
        <dd className="font-mono text-xs">{data.id}</dd>
        <dt className="text-slate-500">Created</dt>
        <dd>{formatDate(data.created_at)}</dd>
      </dl>

      <h2 className="mb-2 text-sm font-semibold text-slate-700">Deliveries</h2>
      {data.deliveries.length === 0 ? (
        <Empty>No endpoint subscribes to this event type.</Empty>
      ) : (
        <Table head={['Endpoint', 'Status', 'Attempts', 'Next attempt', '']}>
          {data.deliveries.map((delivery) => (
            <tr key={delivery.id}>
              <td className="px-4 py-2">
                <Link
                  to={`/deliveries/${delivery.id}`}
                  className="break-all hover:underline"
                >
                  {delivery.endpoint_url}
                </Link>
              </td>
              <td className="px-4 py-2">
                <StatusBadge status={delivery.status} />
              </td>
              <td className="px-4 py-2">{delivery.attempt_count}</td>
              <td className="px-4 py-2 text-slate-600">
                {formatDate(delivery.next_attempt_at)}
              </td>
              <td className="px-4 py-2">
                {delivery.status === 'dead' && (
                  <RetryButton deliveryId={delivery.id} />
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      <h2 className="mt-6 mb-2 text-sm font-semibold text-slate-700">
        Payload
      </h2>
      <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
        {formatJson(data.payload)}
      </pre>
    </>
  );
}
