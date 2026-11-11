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
  Field,
  formClass,
  Loading,
  monoInputClass,
  PageHeader,
  Switch,
  Table,
  Url,
} from '../components/ui';
import { formatTime } from '../format';

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
      <PageHeader
        title="Endpoints"
        description="Where Hookline sends your events, and how each one is doing."
      >
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
        <Empty>No endpoints yet. Add one to start receiving events.</Empty>
      ) : (
        <Table head={['URL', 'Event types', 'Health', 'Active', '']}>
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
      <td>
        <Url url={endpoint.url} />
      </td>
      <td>
        <div className="flex flex-wrap gap-1">
          {endpoint.event_types.map((type) => (
            <span
              key={type}
              className="rounded bg-rule-soft px-[7px] py-0.5 font-mono text-xs text-ink-2"
            >
              {type}
            </span>
          ))}
        </div>
      </td>
      <td className="text-[13px]">
        {endpoint.status === 'disabled' ? (
          <span className="text-ink-3">Off: receives no events</span>
        ) : circuitOpen ? (
          <>
            <span className="font-medium text-bad">
              Paused until {formatTime(endpoint.circuit_open_until)}
            </span>
            <span className="block text-xs text-ink-3">
              {endpoint.consecutive_failures} failures in a row
            </span>
          </>
        ) : endpoint.consecutive_failures > 0 ? (
          <span className="text-wait">
            {endpoint.consecutive_failures === 1
              ? '1 failure in a row'
              : `${endpoint.consecutive_failures} failures in a row`}
          </span>
        ) : (
          <span className="text-ink-2">Healthy</span>
        )}
      </td>
      <td>
        <Switch
          label="Active"
          checked={endpoint.status === 'active'}
          disabled={toggle.isPending}
          onChange={() => toggle.mutate()}
        />
      </td>
      <td>
        <div className="flex flex-wrap justify-end gap-1">
          <Button
            variant="quiet"
            size="sm"
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
            size="sm"
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
    <form onSubmit={submit} className={formClass}>
      <h2>Add an endpoint</h2>
      <Field label="URL">
        <input
          type="url"
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/webhooks"
          className={monoInputClass}
        />
      </Field>
      <Field
        label="Event types"
        hint="Separate them with commas. The endpoint receives only these types."
      >
        <input
          required
          value={types}
          onChange={(event) => setTypes(event.target.value)}
          placeholder="order.created, order.paid"
          className={monoInputClass}
        />
      </Field>
      {create.error && <ErrorMessage error={create.error} />}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          Add endpoint
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
    <div className="mb-6 space-y-3 rounded-[10px] border border-stamp/30 bg-stamp-wash p-4 text-sm">
      <p>
        <strong className="font-semibold">Copy the signing secret now.</strong>{' '}
        It is shown only this once. <Url url={url} /> uses it to check that a
        request came from Hookline.
      </p>
      <div className="flex flex-wrap gap-2">
        <code className="min-w-0 flex-1 rounded-md border border-rule bg-surface px-3 py-2 font-mono text-[13px] [overflow-wrap:anywhere]">
          {value}
        </code>
        <Button
          variant="primary"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}
