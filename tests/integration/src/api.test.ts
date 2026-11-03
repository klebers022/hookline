import { buildApp, createProject } from '@hookline/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

describe('API reliability', () => {
  let h: Harness;

  async function publishWithKey(
    idempotencyKey: string,
    type: string,
    payload: object = { amount: 100 },
  ) {
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: {
        authorization: `Bearer ${h.apiKey}`,
        'idempotency-key': idempotencyKey,
      },
      payload: { type, payload },
    });
    return {
      status: response.statusCode,
      body: response.json(),
      replayed: response.headers['idempotent-replayed'],
    };
  }

  function lastSignatureValid(eventId: string) {
    return h.receiver.received.find((item) => item.id === eventId)
      ?.signature_valid;
  }

  async function deliveredSignature(type: string, secret: string) {
    h.receiver.configure({ secret });
    const event = await h.publish(type);
    await h.waitForDelivery(event.id, 'succeeded');
    return lastSignatureValid(event.id);
  }

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(() => {
    h.receiver.configure({ status: 200, delay_ms: 0, fail_next: 0 });
  });

  describe('Idempotency-Key', () => {
    it('returns the original event for a repeated request', async () => {
      await h.createEndpoint(['idempotent.repeat']);

      const first = await publishWithKey('repeat-1', 'idempotent.repeat');
      const second = await publishWithKey('repeat-1', 'idempotent.repeat');

      expect(first.status).toBe(202);
      expect(first.replayed).toBeUndefined();
      expect(second.status).toBe(202);
      expect(second.replayed).toBe('true');
      expect(second.body).toEqual(first.body);

      await h.waitForDelivery(first.body.id, 'succeeded');
      const { rows } = await h.pool.query(
        `SELECT count(*)::int AS events FROM events WHERE idempotency_key = 'repeat-1'`,
      );
      expect(rows[0].events).toBe(1);
      expect(
        h.receiver.received.filter((item) => item.id === first.body.id),
      ).toHaveLength(1);
    });

    it('creates a single event for concurrent requests', async () => {
      await h.createEndpoint(['idempotent.concurrent']);

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          publishWithKey('concurrent-1', 'idempotent.concurrent'),
        ),
      );

      expect(new Set(responses.map(({ status }) => status))).toEqual(
        new Set([202]),
      );
      expect(new Set(responses.map(({ body }) => body.id)).size).toBe(1);
      expect(responses.filter(({ replayed }) => !replayed)).toHaveLength(1);
      expect(new Set(responses.map(({ body }) => body.deliveries))).toEqual(
        new Set([1]),
      );
    });

    it('rejects a key reused with different content', async () => {
      await publishWithKey('conflict-1', 'idempotent.conflict', { amount: 1 });

      const payload = await publishWithKey(
        'conflict-1',
        'idempotent.conflict',
        { amount: 2 },
      );
      const type = await publishWithKey('conflict-1', 'idempotent.other', {
        amount: 1,
      });

      expect(payload.status).toBe(409);
      expect(type.status).toBe(409);
    });

    it('treats a reordered payload as the same request', async () => {
      await publishWithKey('order-1', 'idempotent.order', { a: 1, b: 2 });

      const second = await publishWithKey('order-1', 'idempotent.order', {
        b: 2,
        a: 1,
      });

      expect(second.status).toBe(202);
      expect(second.replayed).toBe('true');
    });

    it('scopes keys to each project', async () => {
      const first = await publishWithKey('scoped-1', 'idempotent.scoped');
      const other = await createProject(h.pool, 'other');

      const { status, body } = await h.call(
        'POST',
        '/v1/events',
        { type: 'idempotent.other-project', payload: {} },
        other.apiKey,
      );
      const response = await h.app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: {
          authorization: `Bearer ${other.apiKey}`,
          'idempotency-key': 'scoped-1',
        },
        payload: { type: 'idempotent.other-project', payload: {} },
      });

      expect(status).toBe(202);
      expect(body.id).not.toBe(first.body.id);
      expect(response.statusCode).toBe(202);
      expect(response.headers['idempotent-replayed']).toBeUndefined();
      expect(response.json().id).not.toBe(first.body.id);
    });
  });

  describe('secret rotation', () => {
    it('signs with both secrets during the overlap', async () => {
      const { id, secret: oldSecret } = await h.createEndpoint(['rotate.both']);

      const { status, body } = await h.call(
        'POST',
        `/v1/endpoints/${id}/rotate-secret`,
      );

      expect(status).toBe(200);
      expect(body.secret).not.toBe(oldSecret);
      expect(body).not.toHaveProperty('secret_encrypted');
      expect(body).not.toHaveProperty('previous_secret_encrypted');
      expect(
        new Date(body.previous_secret_expires_at).getTime(),
      ).toBeGreaterThan(Date.now());
      expect(await deliveredSignature('rotate.both', oldSecret)).toBe(true);
      expect(await deliveredSignature('rotate.both', body.secret)).toBe(true);
    });

    it('stops signing with the old secret after the overlap', async () => {
      const { id, secret: oldSecret } = await h.createEndpoint([
        'rotate.expired',
      ]);
      const { body } = await h.call(
        'POST',
        `/v1/endpoints/${id}/rotate-secret`,
      );
      await h.pool.query(
        `UPDATE endpoints SET previous_secret_expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [id],
      );

      expect(await deliveredSignature('rotate.expired', oldSecret)).toBe(false);
      expect(await deliveredSignature('rotate.expired', body.secret)).toBe(
        true,
      );
    });

    it('does not rotate the secret of another project', async () => {
      const { id } = await h.createEndpoint(['rotate.foreign']);
      const other = await createProject(h.pool, 'other');

      const { status } = await h.call(
        'POST',
        `/v1/endpoints/${id}/rotate-secret`,
        undefined,
        other.apiKey,
      );

      expect(status).toBe(404);
    });
  });

  // Some clients, such as PowerShell's Invoke-RestMethod, send a Content-Type
  // on a POST without a body.
  describe('POST without a body', () => {
    function rotate(id: string, contentType: string) {
      return h.app.inject({
        method: 'POST',
        url: `/v1/endpoints/${id}/rotate-secret`,
        headers: {
          authorization: `Bearer ${h.apiKey}`,
          'content-type': contentType,
        },
        payload: '',
      });
    }

    it.each([
      'application/x-www-form-urlencoded',
      'application/json',
      'text/plain',
    ])('accepts an empty body sent as %s', async (contentType) => {
      const { id } = await h.createEndpoint(['empty.body']);

      const response = await rotate(id, contentType);

      expect(response.statusCode).toBe(200);
    });

    it('still rejects a body in an unsupported format', async () => {
      const response = await h.app.inject({
        method: 'POST',
        url: '/v1/endpoints',
        headers: {
          authorization: `Bearer ${h.apiKey}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: 'url=https%3A%2F%2Fexample.com&event_types=a',
      });

      expect(response.statusCode).toBe(415);
      expect(response.json()).toMatchObject({
        title: 'Unsupported Media Type',
        status: 415,
      });
    });

    it('still rejects malformed JSON', async () => {
      const response = await h.app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: {
          authorization: `Bearer ${h.apiKey}`,
          'content-type': 'application/json',
        },
        payload: '{"type":',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ title: 'Bad Request' });
    });
  });

  describe('rate limit', () => {
    let limited: Awaited<ReturnType<typeof buildApp>>;

    function list(key: string) {
      return limited.inject({
        method: 'GET',
        url: '/v1/events',
        headers: { authorization: `Bearer ${key}` },
      });
    }

    beforeAll(async () => {
      limited = await buildApp({
        pool: h.pool,
        encryptionKey: h.encryptionKey,
        rateLimitPerMinute: 2,
      });
    });

    afterAll(async () => {
      await limited?.close();
    });

    it('limits each project separately and ignores invalid keys', async () => {
      const { apiKey } = await createProject(h.pool, 'limited');
      const other = await createProject(h.pool, 'not-limited');

      for (let i = 0; i < 5; i += 1) {
        expect((await list('hk_invalid')).statusCode).toBe(401);
      }
      expect((await list(apiKey)).statusCode).toBe(200);
      expect((await list(apiKey)).statusCode).toBe(200);

      const blocked = await list(apiKey);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.json()).toMatchObject({
        title: 'Too Many Requests',
        status: 429,
      });

      expect((await list(other.apiKey)).statusCode).toBe(200);
    });
  });
});
