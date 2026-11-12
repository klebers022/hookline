import { verifyWebhook } from '@hookline/shared';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const MAX_RECEIVED = 1000;

// /hooks is the default destination. /hooks/<name> is another one, with a
// behavior and counters of its own, so one receiver can play several
// customers at once (the chaos test uses three).
const DEFAULT = 'default';
const NAMED_ROUTE = /^(POST \/hooks|POST \/control)\/([a-z0-9-]{1,40})$/;

export interface ReceivedWebhook {
  id: string;
  body: unknown;
  signature_valid: boolean | null;
  received_at: string;
}

export interface Behavior {
  secret?: string;
  status: number;
  delay_ms: number;
  // This many requests fail with a 500, then the status above returns.
  fail_next: number;
  // The share of requests, from 0 to 1, that fail with a 500 at random.
  fail_rate: number;
}

// requests counts every call; accepted, the ones answered with a 2xx.
// unique counts the webhook-id values accepted. At-least-once delivery
// allows the same webhook to be accepted twice (the sender can die after
// the answer and before recording it), so accepted minus unique is how
// many duplicates arrived. A retry after a failure is not a duplicate.
export interface DestinationStats {
  requests: number;
  accepted: number;
  unique: number;
  duplicates: number;
}

interface Destination {
  behavior: Behavior;
  requests: number;
  accepted: number;
  ids: Set<string>;
}

function newDestination(): Destination {
  return {
    behavior: { status: 200, delay_ms: 0, fail_next: 0, fail_rate: 0 },
    requests: 0,
    accepted: 0,
    ids: new Set(),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

// The behavior without the secret, which /control never echoes.
function publicBehavior(behavior: Behavior) {
  const { status, delay_ms, fail_next, fail_rate } = behavior;
  return { status, delay_ms, fail_next, fail_rate };
}

export async function startReceiver(port = 0, host = '127.0.0.1') {
  const received: ReceivedWebhook[] = [];
  const destinations = new Map<string, Destination>();

  function destination(name: string): Destination {
    let found = destinations.get(name);
    if (!found) {
      found = newDestination();
      destinations.set(name, found);
    }
    return found;
  }

  function checkSignature(
    behavior: Behavior,
    request: IncomingMessage,
    body: string,
  ): boolean | null {
    if (!behavior.secret) {
      return null;
    }
    return verifyWebhook({
      secret: behavior.secret,
      id: String(request.headers['webhook-id']),
      timestamp: Number(request.headers['webhook-timestamp']),
      body,
      signatureHeader: String(request.headers['webhook-signature']),
    });
  }

  async function handleWebhook(
    name: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const target = destination(name);
    const { behavior } = target;
    const body = await readBody(request);
    const id = String(request.headers['webhook-id']);
    target.requests += 1;
    if (received.length >= MAX_RECEIVED) {
      received.shift();
    }
    received.push({
      id,
      body: JSON.parse(body),
      signature_valid: checkSignature(behavior, request, body),
      received_at: new Date().toISOString(),
    });
    let failing = behavior.fail_next > 0;
    if (failing) {
      behavior.fail_next -= 1;
    } else if (behavior.fail_rate > 0) {
      failing = Math.random() < behavior.fail_rate;
    }
    const status = failing ? 500 : behavior.status;
    await sleep(behavior.delay_ms);
    if (status >= 200 && status < 300) {
      target.accepted += 1;
      target.ids.add(id);
    }
    sendJson(response, status, { received: true });
  }

  async function handleControl(
    name: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const target = destination(name);
    target.behavior = {
      ...target.behavior,
      ...(JSON.parse(await readBody(request)) as Partial<Behavior>),
    };
    sendJson(response, 200, publicBehavior(target.behavior));
  }

  function stats(): Record<string, DestinationStats> {
    return Object.fromEntries(
      [...destinations].map(([name, { requests, accepted, ids }]) => [
        name,
        {
          requests,
          accepted,
          unique: ids.size,
          duplicates: accepted - ids.size,
        },
      ]),
    );
  }

  const server = createServer((request, response) => {
    const route = `${request.method} ${request.url}`;
    const handle = async () => {
      const named = NAMED_ROUTE.exec(route);
      if (named) {
        const [, kind, name] = named as unknown as [string, string, string];
        return kind === 'POST /hooks'
          ? handleWebhook(name, request, response)
          : handleControl(name, request, response);
      }
      switch (route) {
        case 'POST /hooks':
          return handleWebhook(DEFAULT, request, response);
        case 'POST /control':
          return handleControl(DEFAULT, request, response);
        case 'GET /received':
          return sendJson(response, 200, { count: received.length, received });
        case 'GET /stats':
          return sendJson(response, 200, stats());
        // Forgets every destination: behaviors, counters and the list.
        case 'POST /reset':
          destinations.clear();
          received.length = 0;
          return sendJson(response, 200, {});
        default:
          return sendJson(response, 404, { error: 'Not found' });
      }
    };
    handle().catch((error: unknown) => {
      sendJson(response, 400, { error: String(error) });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}`,
    received,
    stats,
    configure(next: Partial<Behavior>, name = DEFAULT): void {
      const target = destination(name);
      target.behavior = { ...target.behavior, ...next };
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
