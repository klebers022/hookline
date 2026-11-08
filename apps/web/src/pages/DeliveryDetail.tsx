import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { REFRESH_MS } from '../api/queries';
import {
  isFinal,
  type Attempt,
  type DeliveryDetail as Detail,
} from '../api/types';
import { useApi } from '../auth';
import { RetryButton } from '../components/RetryButton';
import {
  Empty,
  ErrorMessage,
  Loading,
  PageHeader,
  StatusBadge,
} from '../components/ui';
import { formatDate } from '../format';

export function DeliveryDetail() {
  const { id } = useParams();
  const api = useApi();
  const delivery = useQuery({
    queryKey: ['delivery', id],
    queryFn: () => api.get<Detail>(`/v1/deliveries/${id}`),
    refetchInterval: (query) =>
      query.state.data && isFinal(query.state.data.status) ? false : REFRESH_MS,
  });

  if (delivery.isPending) {
    return <Loading />;
  }
  if (delivery.error) {
    return <ErrorMessage error={delivery.error} />;
  }
  const { data } = delivery;
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Delivery <StatusBadge status={data.status} />
          </span>
        }
      >
        {data.status === 'dead' && <RetryButton deliveryId={data.id} />}
      </PageHeader>
      <dl className="mb-6 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-slate-500">Event</dt>
        <dd>
          <Link to={`/events/${data.event_id}`} className="hover:underline">
            {data.event_type}
          </Link>
        </dd>
        <dt className="text-slate-500">Endpoint</dt>
        <dd className="break-all">{data.endpoint_url}</dd>
        <dt className="text-slate-500">Next attempt</dt>
        <dd>{formatDate(data.next_attempt_at)}</dd>
        <dt className="text-slate-500">Delivered</dt>
        <dd>{formatDate(data.delivered_at)}</dd>
      </dl>

      <h2 className="mb-2 text-sm font-semibold text-slate-700">
        Attempts ({data.attempts.length})
      </h2>
      {data.attempts.length === 0 ? (
        <Empty>No attempt yet.</Empty>
      ) : (
        <ol className="space-y-2">
          {data.attempts.map((attempt) => (
            <AttemptItem key={attempt.attempt_number} attempt={attempt} />
          ))}
        </ol>
      )}
    </>
  );
}

function AttemptItem({ attempt }: { attempt: Attempt }) {
  const status = attempt.response_status;
  const ok = status !== null && status >= 200 && status < 300;
  return (
    <li
      data-testid="attempt"
      className="rounded-lg bg-white p-3 text-sm ring-1 ring-slate-200"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium">#{attempt.attempt_number}</span>
        <span className={ok ? 'text-emerald-700' : 'font-medium text-red-700'}>
          {status ?? attempt.error_code ?? '—'}
        </span>
        {status !== null && attempt.error_code && (
          <span className="text-red-700">{attempt.error_code}</span>
        )}
        <span className="text-slate-500">{formatDate(attempt.started_at)}</span>
        {attempt.duration_ms !== null && (
          <span className="text-slate-500">{attempt.duration_ms} ms</span>
        )}
      </div>
      {attempt.response_snippet && (
        <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700">
          {attempt.response_snippet}
        </pre>
      )}
    </li>
  );
}
