import { buildApp } from '@hookline/api';
import type { ResolveHost } from '@hookline/shared';
import type { LookupAddress } from 'node:dns';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startHarness, type Harness } from './harness.js';

// Stands in for DNS, so the tests never depend on the network.
const records: Record<string, string> = {
  'hooks.public.test': '93.184.215.14',
  'internal.test': '10.0.0.5',
  'metadata.test': '169.254.169.254',
  'rebind.test': '127.0.0.1',
};

const resolveHost: ResolveHost = (hostname) => {
  const address = records[hostname];
  return address
    ? Promise.resolve([{ address, family: 4 }])
    : Promise.reject(new Error('ENOTFOUND'));
};

describe('SSRF protection', () => {
  let h: Harness;
  let strict: Awaited<ReturnType<typeof buildApp>>;
  const lookupCalls: string[] = [];

  const lookup = vi.fn(
    (
      hostname: string,
      _options: unknown,
      callback: (error: Error | null, addresses: LookupAddress[]) => void,
    ) => {
      lookupCalls.push(hostname);
      const address = records[hostname];
      if (address) {
        callback(null, [{ address, family: 4 }]);
      } else {
        callback(new Error('ENOTFOUND'), []);
      }
    },
  ) as unknown as typeof import('node:dns').lookup;

  async function register(url: string) {
    const response = await strict.inject({
      method: 'POST',
      url: '/v1/endpoints',
      headers: { authorization: `Bearer ${h.apiKey}` },
      payload: { url, event_types: ['ssrf.check'] },
    });
    return { status: response.statusCode, body: response.json() };
  }

  // Registered through the permissive API, as if the address had been
  // public at registration and changed afterwards.
  async function attemptTo(url: string, type: string) {
    const { status } = await h.call('POST', '/v1/endpoints', {
      url,
      event_types: [type],
    });
    expect(status).toBe(201);
    const event = await h.publish(type);
    const delivery = await h.waitForDelivery(event.id, 'retrying');
    const { body } = await h.call('GET', `/v1/deliveries/${delivery.id}`);
    return { event, attempt: body.attempts[0] };
  }

  function callsFor(eventId: string): number {
    return h.receiver.received.filter((item) => item.id === eventId).length;
  }

  beforeAll(async () => {
    h = await startHarness();
    strict = await buildApp({
      pool: h.pool,
      encryptionKey: h.encryptionKey,
      resolveHost,
    });
    await h.processes.worker.stop();
    h.processes.worker = h.newWorker({ allowPrivateTargets: false, lookup });
  });

  afterAll(async () => {
    await strict?.close();
    await h?.stop();
  });

  describe('at registration', () => {
    it('accepts a public https URL', async () => {
      const { status } = await register('https://hooks.public.test/in');

      expect(status).toBe(201);
    });

    it.each([
      ['http://hooks.public.test/in', 'https'],
      ['https://127.0.0.1/in', 'non-public'],
      ['https://[::1]/in', 'non-public'],
      ['https://169.254.169.254/latest/meta-data', 'non-public'],
      ['https://2130706433/in', 'non-public'],
      ['https://internal.test/in', 'non-public'],
      ['https://metadata.test/in', 'non-public'],
      ['https://missing.test/in', 'could not be resolved'],
      ['https://user:secret@hooks.public.test/in', 'credentials'],
    ])('rejects %s', async (url, reason) => {
      const { status, body } = await register(url);

      expect(status).toBe(400);
      expect(body.detail).toContain(reason);
    });

    it('rejects an internal URL in an update', async () => {
      const { body: endpoint } = await register('https://hooks.public.test/in');

      const response = await strict.inject({
        method: 'PATCH',
        url: `/v1/endpoints/${endpoint.id}`,
        headers: { authorization: `Bearer ${h.apiKey}` },
        payload: { url: 'https://internal.test/in' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('on delivery', () => {
    it('blocks a hostname that now resolves to an internal address', async () => {
      const port = new URL(h.receiver.url).port;

      const { event, attempt } = await attemptTo(
        `https://rebind.test:${port}/hooks`,
        'ssrf.rebind',
      );

      expect(attempt.error_code).toBe('SSRF_BLOCKED');
      expect(attempt.response_status).toBeNull();
      expect(lookupCalls).toContain('rebind.test');
      expect(callsFor(event.id)).toBe(0);
    });

    it('blocks an internal address written in the URL', async () => {
      const port = new URL(h.receiver.url).port;
      lookupCalls.length = 0;

      const { event, attempt } = await attemptTo(
        `https://127.0.0.1:${port}/hooks`,
        'ssrf.literal',
      );

      expect(attempt.error_code).toBe('SSRF_BLOCKED');
      expect(lookupCalls).toEqual([]);
      expect(callsFor(event.id)).toBe(0);
    });

    it('blocks plain http', async () => {
      const { event, attempt } = await attemptTo(
        `${h.receiver.url}/hooks`,
        'ssrf.http',
      );

      expect(attempt.error_code).toBe('SSRF_BLOCKED');
      expect(callsFor(event.id)).toBe(0);
    });
  });
});
