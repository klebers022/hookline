import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { usePagedList } from '../api/queries';
import type { Endpoint, EndpointWithSecret } from '../api/types';
import { useApi } from '../auth';
import { LoadMore } from '../components/LoadMore';
import {
  Button,
  Empty,
  ErrorMessage,
  inputClass,
  Loading,
  PageHeader,
  StatusBadge,
  Table,
} from '../components/ui';
import { formatDate } from '../format';

export function Endpoints() {
  const [creating, setCreating] = useState(false);
  // A secret is shown once, right after the API creates it.
  const [secret, setSecret] = useState<{ url: string; value: string } | null>(
    null,
  );
  const list = usePagedList<Endpoint>(['endpoints'], '/v1/endpoints?limit=25');

  function showSecret(endpoint: EndpointWithSecret) {
    setCreating(false);
    setSecret({ url: endpoint.url, value: endpoint.secret });
  }

  return (
    <>
      <PageHeader title="Endpoints">
        <Button variant="primary" onClick={() => setCreating(!creating)}>
          Add endpoint
        </Button>
      </PageHeader>
      {secret && <SecretNotice {...secret} onDismiss={() => setSecret(null)} />}
      {creating && (
        <CreateForm onCreated={showSecret} onClose={() => setCreating(false)} />
      )}
      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorMessage error={list.error} />
      ) : list.rows.length === 0 ? (
        <Empty>No endpoints yet.</Empty>
      ) : (
        <Table head={['URL', 'Event types', 'Status', 'Circuit', '']}>
          {list.rows.map((endpoint) => (
            <EndpointRow
              key={endpoint.id}
              endpoint={endpoint}
              onRotated={showSecret}
            />
          ))}
        </Table>
      )}
      <LoadMore {...list} />
    </>
  );
}

function EndpointRow({
  endpoint,
  onRotated,
}: {
  endpoint: Endpoint;
  onRotated: (endpoint: EndpointWithSecret) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['endpoints'] });
  const path = `/v1/endpoints/${endpoint.id}`;

  const toggle = useMutation({
    mutationFn: () =>
      api.patch(path, {
        status: endpoint.status === 'active' ? 'disabled' : 'active',
      }),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: () => api.post<EndpointWithSecret>(`${path}/rotate-secret`),
    onSuccess: onRotated,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(path),
    onSuccess: refresh,
  });
  const error = toggle.error ?? rotate.error ?? remove.error;
  const circuitOpen =
    endpoint.circuit_open_until !== null &&
    new Date(endpoint.circuit_open_until) > new Date();

  return (
    <tr>
      <td className="px-4 py-2 break-all">{endpoint.url}</td>
      <td className="px-4 py-2 text-slate-600">
        {endpoint.event_types.join(', ')}
      </td>
      <td className="px-4 py-2">
        <StatusBadge status={endpoint.status} />
      </td>
      <td className="px-4 py-2 text-slate-600">
        {circuitOpen
          ? `open until ${formatDate(endpoint.circuit_open_until)}`
          : `closed (${endpoint.consecutive_failures} failures)`}
      </td>
      <td className="px-4 py-2">
        <div className="flex flex-wrap gap-2">
          <Button disabled={toggle.isPending} onClick={() => toggle.mutate()}>
            {endpoint.status === 'active' ? 'Disable' : 'Enable'}
          </Button>
          <Button
            disabled={rotate.isPending}
            onClick={() => {
              if (
                window.confirm(
                  'Rotate the secret? The old one keeps working for 24 hours.',
                )
              ) {
                rotate.mutate();
              }
            }}
          >
            Rotate secret
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete ${endpoint.url}?`)) {
                remove.mutate();
              }
            }}
          >
            Delete
          </Button>
        </div>
        {error && <ErrorMessage error={error} />}
      </td>
    </tr>
  );
}

function CreateForm({
  onCreated,
  onClose,
}: {
  onCreated: (endpoint: EndpointWithSecret) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [types, setTypes] = useState('');

  const create = useMutation({
    mutationFn: (body: { url: string; event_types: string[] }) =>
      api.post<EndpointWithSecret>('/v1/endpoints', body),
    onSuccess: async (endpoint) => {
      await queryClient.invalidateQueries({ queryKey: ['endpoints'] });
      onCreated(endpoint);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({
      url: url.trim(),
      event_types: types
        .split(',')
        .map((type) => type.trim())
        .filter(Boolean),
    });
  }

  return (
    <form
      onSubmit={submit}
      className="mb-6 space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200"
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">URL</span>
        <input
          type="url"
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/webhooks"
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">
          Event types (comma separated)
        </span>
        <input
          required
          value={types}
          onChange={(event) => setTypes(event.target.value)}
          placeholder="order.created, order.paid"
          className={inputClass}
        />
      </label>
      {create.error && <ErrorMessage error={create.error} />}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          Create
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

function SecretNotice({
  url,
  value,
  onDismiss,
}: {
  url: string;
  value: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-6 space-y-2 rounded-lg bg-amber-50 p-4 text-sm ring-1 ring-amber-300">
      <p className="font-medium text-amber-900">
        Signing secret for {url}. Copy it now: it is not shown again.
      </p>
      <code className="block rounded bg-white px-3 py-2 font-mono break-all ring-1 ring-amber-200">
        {value}
      </code>
      <div className="flex gap-2">
        <Button
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button onClick={onDismiss}>Done</Button>
      </div>
    </div>
  );
}
