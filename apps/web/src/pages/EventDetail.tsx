import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { REFRESH_MS } from '../api/queries';
import { isFinal, type EventDetail as Detail } from '../api/types';
import { useApi } from '../auth';
import { RetryButton } from '../components/RetryButton';
import {
  codeClass,
  Empty,
  ErrorMessage,
  Loading,
  PageHeader,
  StatusBadge,
  Table,
  Time,
  Url,
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
  const count = data.deliveries.length;
  return (
    <>
      <PageHeader
        crumbs={
          <>
            <Link to="/events" className="text-ink-2 hover:underline">
              Events
            </Link>{' '}
            /
          </>
        }
        title={data.type}
        description={
          <>
            <span>Published {formatDate(data.created_at)}</span>
            <span className="font-mono text-[13px] text-ink-3">{data.id}</span>
          </>
        }
      />

      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section>
          <h2 className="mb-3">
            {count === 1 ? 'Sent to 1 endpoint' : `Sent to ${count} endpoints`}
          </h2>
          {count === 0 ? (
            <Empty>No endpoint subscribes to this event type.</Empty>
          ) : (
            <Table
              head={['Endpoint', 'Status', 'Attempts', 'Next attempt', '']}
            >
              {data.deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td>
                    <Link
                      to={`/deliveries/${delivery.id}`}
                      className="hover:underline"
                    >
                      <Url url={delivery.endpoint_url} />
                    </Link>
                  </td>
                  <td>
                    <StatusBadge status={delivery.status} />
                  </td>
                  <td className="font-mono text-[13px]">
                    {delivery.attempt_count}
                  </td>
                  <td className="whitespace-nowrap text-ink-2">
                    <Time value={delivery.next_attempt_at} />
                  </td>
                  <td>
                    {delivery.status === 'dead' && (
                      <RetryButton deliveryId={delivery.id} size="sm" />
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </section>

        <section>
          <h2 className="mb-3">Payload</h2>
          <pre className={codeClass}>{formatJson(data.payload)}</pre>
        </section>
      </div>
    </>
  );
}
