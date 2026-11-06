import { afterEach, describe, expect, it } from 'vitest';
import { Counter, createRegistry, startOpsServer } from './metrics.js';

describe('startOpsServer', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start(isReady?: () => boolean | Promise<boolean>) {
    const registry = createRegistry('test');
    const server = await startOpsServer({
      registry,
      port: 0,
      ...(isReady && { isReady }),
    });
    close = server.close;
    return { registry, url: server.url };
  }

  it('serves the registry with the service label', async () => {
    const { registry, url } = await start();
    new Counter({
      name: 'test_things_total',
      help: 'Things',
      registers: [registry],
    }).inc(3);

    const response = await fetch(`${url}/metrics`);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('test_things_total{service="test"} 3');
    expect(text).toContain('process_cpu_seconds_total');
  });

  it('answers health checks', async () => {
    let ready = false;
    const { url } = await start(() => ready);

    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/readyz`)).status).toBe(503);
    ready = true;
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
  });

  it('reports not ready when the check throws', async () => {
    const { url } = await start(() => Promise.reject(new Error('down')));

    expect((await fetch(`${url}/readyz`)).status).toBe(503);
  });

  it('answers 404 for anything else', async () => {
    const { url } = await start();

    expect((await fetch(`${url}/`)).status).toBe(404);
  });
});
