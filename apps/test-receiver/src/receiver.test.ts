import { afterEach, describe, expect, it } from 'vitest';
import { startReceiver } from './receiver.js';

type Receiver = Awaited<ReturnType<typeof startReceiver>>;
let receiver: Receiver;

afterEach(async () => {
  await receiver.stop();
});

async function hook(path: string, id: string): Promise<number> {
  const response = await fetch(`${receiver.url}${path}`, {
    method: 'POST',
    headers: { 'webhook-id': id, 'content-type': 'application/json' },
    body: '{}',
  });
  return response.status;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${receiver.url}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response.json();
}

describe('test receiver', () => {
  it('keeps a behavior and counters for each named destination', async () => {
    receiver = await startReceiver();
    await post('/control/down', { status: 503 });

    expect(await hook('/hooks/down', 'a')).toBe(503);
    expect(await hook('/hooks/up', 'a')).toBe(200);
    expect(await hook('/hooks', 'b')).toBe(200);

    const stats = await (await fetch(`${receiver.url}/stats`)).json();
    expect(stats).toEqual({
      down: { requests: 1, accepted: 0, unique: 0, duplicates: 0 },
      up: { requests: 1, accepted: 1, unique: 1, duplicates: 0 },
      default: { requests: 1, accepted: 1, unique: 1, duplicates: 0 },
    });
  });

  it('counts a webhook accepted twice as a duplicate', async () => {
    receiver = await startReceiver();
    await hook('/hooks/x', 'same');
    await hook('/hooks/x', 'same');
    await hook('/hooks/x', 'other');

    expect(receiver.stats()).toEqual({
      x: { requests: 3, accepted: 3, unique: 2, duplicates: 1 },
    });
  });

  it('does not count a retry after a failure as a duplicate', async () => {
    receiver = await startReceiver();
    receiver.configure({ fail_next: 1 }, 'x');
    await hook('/hooks/x', 'same');
    await hook('/hooks/x', 'same');

    expect(receiver.stats()).toEqual({
      x: { requests: 2, accepted: 1, unique: 1, duplicates: 0 },
    });
  });

  it('fails the given share of requests at random', async () => {
    receiver = await startReceiver();
    receiver.configure({ fail_rate: 1 }, 'always');
    receiver.configure({ fail_rate: 0 }, 'never');

    expect(await hook('/hooks/always', '1')).toBe(500);
    expect(await hook('/hooks/never', '2')).toBe(200);
  });

  it('fails the next requests before the random share', async () => {
    receiver = await startReceiver();
    receiver.configure({ fail_next: 1 });

    expect(await hook('/hooks', '1')).toBe(500);
    expect(await hook('/hooks', '2')).toBe(200);
  });

  it('forgets everything on reset', async () => {
    receiver = await startReceiver();
    receiver.configure({ status: 410 }, 'gone');
    await hook('/hooks/gone', '1');

    await post('/reset', {});

    expect(receiver.stats()).toEqual({});
    expect(receiver.received).toHaveLength(0);
    expect(await hook('/hooks/gone', '2')).toBe(200);
  });

  it('answers 404 to a name outside the allowed characters', async () => {
    receiver = await startReceiver();
    expect(await hook('/hooks/Bad_Name', '1')).toBe(404);
  });
});
