import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const RECEIVER = process.env.RECEIVER_URL ?? 'http://127.0.0.1:4000';
// The address the delivery worker uses, inside the compose network.
export const RECEIVER_IN_NETWORK = 'http://test-receiver:4000/hooks';

async function request<T>(
  url: string,
  {
    method = 'GET',
    body,
    apiKey,
  }: {
    method?: string;
    body?: unknown;
    apiKey?: string;
  } = {},
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(apiKey && { authorization: `Bearer ${apiKey}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${url}: ${response.status} ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

// A project of its own, created the way an operator would, inside the API
// container. The key is printed once and only kept in this process.
export function createProject(name: string): string {
  const output = execFileSync(
    'docker',
    [
      'compose',
      '--profile',
      'app',
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'api',
      'node',
      'dist/scripts/create-project.js',
      name,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const apiKey = output.match(/API key \(shown only once\): (\S+)/)?.[1];
  if (!apiKey) {
    throw new Error('No API key in the output of create-project');
  }
  return apiKey;
}

export function api(apiKey: string) {
  return {
    createEndpoint: (eventTypes: string[]) =>
      request<{ id: string }>(`${API}/v1/endpoints`, {
        method: 'POST',
        apiKey,
        body: { url: RECEIVER_IN_NETWORK, event_types: eventTypes },
      }),
    disableEndpoint: (id: string) =>
      request(`${API}/v1/endpoints/${id}`, {
        method: 'PATCH',
        apiKey,
        body: { status: 'disabled' },
      }),
    publish: (type: string, payload: Record<string, unknown>) =>
      request<{ id: string }>(`${API}/v1/events`, {
        method: 'POST',
        apiKey,
        body: { type, payload },
      }),
    delivery: async (eventId: string) => {
      const event = await request<{
        deliveries: { id: string; status: string; attempt_count: number }[];
      }>(`${API}/v1/events/${eventId}`, { apiKey });
      const delivery = event.deliveries[0];
      if (!delivery) {
        throw new Error(`Event ${eventId} has no delivery`);
      }
      return delivery;
    },
  };
}

export function configureReceiver(behavior: { status: number }) {
  return request(`${RECEIVER}/control`, {
    method: 'POST',
    body: { ...behavior, delay_ms: 0, fail_next: 0 },
  });
}

export async function waitFor<T>(
  description: string,
  check: () => Promise<T | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await sleep(250);
  }
}
