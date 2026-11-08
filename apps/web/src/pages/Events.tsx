import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { usePagedList } from '../api/queries';
import type { Event, PublishedEvent } from '../api/types';
import { useApi } from '../auth';
import { LoadMore } from '../components/LoadMore';
import {
  Button,
  Empty,
  ErrorMessage,
  inputClass,
  Loading,
  PageHeader,
  Table,
} from '../components/ui';
import { formatDate } from '../format';

export function Events() {
  const [publishing, setPublishing] = useState(false);
  const list = usePagedList<Event>(['events'], '/v1/events?limit=25');

  return (
    <>
      <PageHeader title="Events">
        <Button variant="primary" onClick={() => setPublishing(!publishing)}>
          Send test event
        </Button>
      </PageHeader>
      {publishing && <PublishForm onClose={() => setPublishing(false)} />}
      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorMessage error={list.error} />
      ) : list.rows.length === 0 ? (
        <Empty>No events yet. Publish one with POST /v1/events.</Empty>
      ) : (
        <Table head={['Type', 'Created', 'ID']}>
          {list.rows.map((event) => (
            <tr key={event.id} className="hover:bg-slate-50">
              <td className="px-4 py-2 font-medium">
                <Link to={`/events/${event.id}`} className="hover:underline">
                  {event.type}
                </Link>
              </td>
              <td className="px-4 py-2 text-slate-600">
                {formatDate(event.created_at)}
              </td>
              <td className="px-4 py-2 font-mono text-xs text-slate-500">
                {event.id}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <LoadMore {...list} />
    </>
  );
}

function PublishForm({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [type, setType] = useState('test.event');
  const [payload, setPayload] = useState('{\n  "hello": "world"\n}');
  const [invalid, setInvalid] = useState<string | null>(null);

  const publish = useMutation({
    mutationFn: (body: { type: string; payload: unknown }) =>
      api.post<PublishedEvent>('/v1/events', body),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ['events'] });
      await navigate(`/events/${id}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      setInvalid('The payload is not valid JSON.');
      return;
    }
    setInvalid(null);
    publish.mutate({ type, payload: parsed });
  }

  return (
    <form
      onSubmit={submit}
      className="mb-6 space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200"
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">Type</span>
        <input
          required
          value={type}
          onChange={(event) => setType(event.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">
          Payload (JSON object)
        </span>
        <textarea
          rows={5}
          value={payload}
          onChange={(event) => setPayload(event.target.value)}
          className={`${inputClass} font-mono`}
        />
      </label>
      {invalid && <ErrorMessage error={new Error(invalid)} />}
      {publish.error && <ErrorMessage error={publish.error} />}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={publish.isPending}>
          Publish
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}
