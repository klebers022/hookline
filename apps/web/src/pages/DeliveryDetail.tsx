import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { REFRESH_MS } from '../api/queries';
import {
  isFinal,
  type Attempt,
  type DeliveryDetail as Detail,
  type Endpoint,
} from '../api/types';
import { useApi } from '../auth';
import { RetryButton } from '../components/RetryButton';
import { Route } from '../components/Route';
import {
  codeClass,
  Empty,
  ErrorMessage,
  Loading,
  PageHeader,
  StatusBadge,
  Url,
} from '../components/ui';
import { formatDate } from '../format';
import { heldUntil, routeStops, routeSummary } from '../route';

export function DeliveryDetail() {
  const { id } = useParams();
  const api = useApi();
  const delivery = useQuery({
    queryKey: ['delivery', id],
    queryFn: () => api.get<Detail>(`/v1/deliveries/${id}`),
    refetchInterval: (query) =>
      query.state.data && isFinal(query.state.data.status) ? false : REFRESH_MS,
  });
  // While the delivery is still going, its endpoint's circuit breaker says
  // whether the next try is being held, and until when.
  const going = delivery.data !== undefined && !isFinal(delivery.data.status);
  const endpoint = useQuery({
    queryKey: ['endpoint', delivery.data?.endpoint_id],
    queryFn: () =>
      api.get<Endpoint>(`/v1/endpoints/${delivery.data?.endpoint_id}`),
    enabled: going,
    refetchInterval: going ? REFRESH_MS : false,
  });

  if (delivery.isPending) {
    return <Loading />;
  }
  if (delivery.error) {
    return <ErrorMessage error={delivery.error} />;
  }
  const { data } = delivery;
  const { attempts } = data;
  const held = going ? heldUntil(endpoint.data?.circuit_open_until) : null;
  return (
    <>
      <PageHeader
        crumbs={
          <>
            <Link to="/events" className="text-ink-2 hover:underline">
              Events
            </Link>{' '}
            /{' '}
            <Link
              to={`/events/${data.event_id}`}
              className="text-ink-2 hover:underline"
            >
              {data.event_type}
            </Link>{' '}
            /
          </>
        }
        title={
          <Url
            url={data.endpoint_url}
            className="text-2xl tracking-[-0.03em]"
          />
        }
        description={
          <>
            <StatusBadge status={data.status} />
            <span>
              {data.attempts.length === 1
                ? '1 attempt'
                : `${data.attempts.length} attempts`}
            </span>
          </>
        }
      >
        {data.status === 'dead' && <RetryButton deliveryId={data.id} />}
      </PageHeader>

      <Route
        summary={routeSummary(data, held)}
        stops={routeStops(data, held)}
      />

      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section>
          <h2 className="mb-3">What the endpoint answered</h2>
          {attempts.length === 0 ? (
            <Empty>No attempt yet. The first one starts within seconds.</Empty>
          ) : (
            <ol className="overflow-hidden rounded-[10px] border border-rule bg-surface">
              {attempts.map((attempt) => (
                <AttemptItem key={attempt.attempt_number} attempt={attempt} />
              ))}
            </ol>
          )}
        </section>

        <section>
          <h2 className="mb-3">Details</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 rounded-[10px] border border-rule bg-surface p-[18px] text-sm">
            <dt className="text-ink-3">Event</dt>
            <dd>
              <Link to={`/events/${data.event_id}`} className="hover:underline">
                {data.event_type}
              </Link>
            </dd>
            <dt className="text-ink-3">Delivered</dt>
            <dd>{formatDate(data.delivered_at)}</dd>
            <dt className="text-ink-3">Created</dt>
            <dd>{formatDate(data.created_at)}</dd>
            <dt className="text-ink-3">Delivery ID</dt>
            <dd className="font-mono text-[13px] [overflow-wrap:anywhere]">
              {data.id}
            </dd>
          </dl>
        </section>
      </div>
    </>
  );
}

function AttemptItem({ attempt }: { attempt: Attempt }) {
  const status = attempt.response_status;
  const ok = status !== null && status >= 200 && status < 300;
  return (
    <li
      data-testid="attempt"
      className="border-b border-rule-soft px-[18px] py-3.5 last:border-b-0"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="w-6 text-sm text-ink-3">{attempt.attempt_number}</span>
        <span
          className={`min-w-24 font-mono font-medium ${ok ? 'text-ok' : 'text-bad'}`}
        >
          {status ?? attempt.error_code ?? '—'}
          {status !== null && attempt.error_code && ` ${attempt.error_code}`}
        </span>
        <span className="text-sm text-ink-2">
          {formatDate(attempt.started_at)}
        </span>
        <span className="ml-auto font-mono text-[13px] text-ink-3">
          {attempt.duration_ms === null ? '' : `${attempt.duration_ms} ms`}
        </span>
      </div>
      {attempt.response_snippet && (
        <pre className={`${codeClass} mt-2 sm:ml-10`}>
          {attempt.response_snippet}
        </pre>
      )}
    </li>
  );
}
