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
  Field,
  formClass,
  Loading,
  monoInputClass,
  PageHeader,
  Table,
  Time,
} from '../components/ui';

export function Events() {
  const [publishing, setPublishing] = useState(false);
  const list = usePagedList<Event>(['events'], '/v1/events?limit=25');

  return (
    <>
      <PageHeader
        title="Events"
        description="Everything this project published, newest first."
      >
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
        <Empty>
          No events yet. Send a test event, or publish one with POST /v1/events.
        </Empty>
      ) : (
        <Table head={['Type', 'Published', 'Event ID']}>
          {list.rows.map((event) => (
            <tr key={event.id}>
              <td className="font-semibold">
                <Link to={`/events/${event.id}`} className="hover:underline">
                  {event.type}
                </Link>
              </td>
              <td className="whitespace-nowrap text-ink-2">
                <Time value={event.created_at} />
              </td>
              <td className="font-mono text-[13px] text-ink-3">{event.id}</td>
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
    <form onSubmit={submit} className={formClass}>
      <h2>Send a test event</h2>
      <Field label="Type" hint="Endpoints subscribed to this type receive it.">
        <input
          required
          value={type}
          onChange={(event) => setType(event.target.value)}
          className={monoInputClass}
        />
      </Field>
      <Field label="Payload (JSON object)">
        <textarea
          rows={5}
          value={payload}
          onChange={(event) => setPayload(event.target.value)}
          className={monoInputClass}
        />
      </Field>
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
