import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from './client';

function respond(status: number, body?: unknown, type = 'application/json') {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': type },
      }),
  );
}

describe('createClient', () => {
  it('sends the key, and JSON only when there is a body', async () => {
    const fetchImpl = respond(200, { ok: true });
    const client = createClient('hk_test', undefined, fetchImpl);

    await client.post('/v1/events', { type: 'a', payload: {} });
    await client.post('/v1/deliveries/1/retry');

    const [withBody, withoutBody] = fetchImpl.mock.calls.map(
      ([, init]) => init,
    );
    expect(withBody?.headers).toEqual({
      authorization: 'Bearer hk_test',
      'content-type': 'application/json',
    });
    expect(withBody?.body).toBe('{"type":"a","payload":{}}');
    // The API rejects an empty body declared as JSON.
    expect(withoutBody?.headers).toEqual({ authorization: 'Bearer hk_test' });
    expect(withoutBody).not.toHaveProperty('body');
  });

  it('turns a problem+json response into an ApiError', async () => {
    const client = createClient(
      'hk_test',
      undefined,
      respond(
        409,
        { title: 'Conflict', detail: 'Delivery is not dead' },
        'application/problem+json',
      ),
    );

    const error = await client.get('/v1/x').catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      title: 'Conflict',
      detail: 'Delivery is not dead',
    });
  });

  it('calls onUnauthorized on a 401 only', async () => {
    const onUnauthorized = vi.fn();
    await createClient('hk_old', onUnauthorized, respond(401, {}))
      .get('/v1/x')
      .catch(() => {});
    await createClient('hk_old', onUnauthorized, respond(404, {}))
      .get('/v1/x')
      .catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('returns nothing for a 204', async () => {
    const client = createClient('hk_test', undefined, respond(204));
    await expect(client.delete('/v1/endpoints/1')).resolves.toBeUndefined();
  });
});
