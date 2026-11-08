import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { Delivery } from './api/types';

const KEY = 'hk_test_key';

const dead: Delivery = {
  id: '0190a000-0000-7000-8000-000000000001',
  event_id: '0190a000-0000-7000-8000-000000000002',
  event_type: 'order.created',
  endpoint_id: '0190a000-0000-7000-8000-000000000003',
  endpoint_url: 'https://example.com/hooks',
  status: 'dead',
  attempt_count: 6,
  next_attempt_at: null,
  delivered_at: null,
  created_at: '2026-11-08T12:00:00.000Z',
};

type Handler = (init: RequestInit | undefined) => Response;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// A fake API: each "METHOD path" answers with its handler, or 404.
function fakeApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth !== `Bearer ${KEY}`) {
        return json(401, { title: 'Unauthorized' });
      }
      const handler = routes[`${init?.method ?? 'GET'} ${String(input)}`];
      return handler ? handler(init) : json(404, { title: 'Not Found' });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function signIn(key = KEY) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('API key'), key);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return user;
}

describe('dashboard', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/failed');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a key the API rejects', async () => {
    fakeApi({});
    render(<App />);

    await signIn('hk_wrong');

    expect(await screen.findByRole('alert')).toHaveTextContent('Unauthorized');
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
  });

  it('lists a dead delivery and retries it', async () => {
    let retried = false;
    const fetchMock = fakeApi({
      'GET /v1/endpoints?limit=1': () => json(200, { data: [] }),
      'GET /v1/deliveries?status=dead&limit=25': () =>
        json(200, {
          data: retried ? [] : [dead],
          next_cursor: null,
        }),
      [`POST /v1/deliveries/${dead.id}/retry`]: () => {
        retried = true;
        return json(202, { status: 'pending', attempt: 7 });
      },
    });
    render(<App />);

    const user = await signIn();
    expect(await screen.findByText('order.created')).toBeInTheDocument();
    expect(screen.getByText(dead.endpoint_url)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    // The list is fetched again and the delivery has left it.
    expect(await screen.findByText('Nothing here.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/v1/deliveries/${dead.id}/retry`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows why the API refused a retry', async () => {
    fakeApi({
      'GET /v1/endpoints?limit=1': () => json(200, { data: [] }),
      'GET /v1/deliveries?status=dead&limit=25': () =>
        json(200, { data: [dead], next_cursor: null }),
      [`POST /v1/deliveries/${dead.id}/retry`]: () =>
        json(409, { title: 'Conflict', detail: 'Endpoint is disabled' }),
    });
    render(<App />);

    const user = await signIn();
    await user.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Conflict: Endpoint is disabled',
    );
  });

  it('goes back to the sign-in when the key stops working', async () => {
    let revoked = false;
    fakeApi({
      'GET /v1/endpoints?limit=1': () => json(200, { data: [] }),
      'GET /v1/deliveries?status=dead&limit=25': () =>
        revoked
          ? json(401, { title: 'Unauthorized' })
          : json(200, { data: [dead], next_cursor: null }),
    });
    render(<App />);

    const user = await signIn();
    await screen.findByText('order.created');
    revoked = true;
    await user.click(screen.getByRole('tab', { name: 'Retrying' }));
    await user.click(screen.getByRole('tab', { name: 'Dead' }));

    await waitFor(() =>
      expect(screen.getByLabelText('API key')).toBeInTheDocument(),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The API rejected the key.',
    );
  });
});
