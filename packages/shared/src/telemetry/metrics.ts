import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { collectDefaultMetrics, Registry } from 'prom-client';

export { Counter, Gauge, Histogram, Registry } from 'prom-client';

// Every metric from a process carries its name, so dashboards can tell the
// API, the relay and the delivery worker apart.
export function createRegistry(service: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return registry;
}

export interface OpsServerOptions {
  registry: Registry;
  port: number;
  host?: string;
  isReady?: () => boolean | Promise<boolean>;
}

// Metrics and health checks are served on a port of their own, which is never
// published, so nobody on the internet can read them through the API's port.
// /healthz says the process is alive; /readyz says it can do its work.
export async function startOpsServer({
  registry,
  port,
  host = '127.0.0.1',
  isReady = () => true,
}: OpsServerOptions) {
  const server = createServer((request, response) => {
    const handle = async (): Promise<void> => {
      switch (request.url) {
        case '/metrics':
          response.writeHead(200, { 'content-type': registry.contentType });
          response.end(await registry.metrics());
          return;
        case '/healthz':
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: 'ok' }));
          return;
        case '/readyz': {
          const ready = await isReady();
          response.writeHead(ready ? 200 : 503, {
            'content-type': 'application/json',
          });
          response.end(
            JSON.stringify({ status: ready ? 'ready' : 'unavailable' }),
          );
          return;
        }
        default:
          response.writeHead(404).end();
      }
    };
    handle().catch(() => {
      if (!response.headersSent) {
        response.writeHead(503);
      }
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
