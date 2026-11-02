import { verifyWebhook } from '@hookline/shared';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const MAX_RECEIVED = 1000;

export interface ReceivedWebhook {
  id: string;
  body: unknown;
  signature_valid: boolean | null;
  received_at: string;
}

interface Behavior {
  secret?: string;
  status: number;
  delay_ms: number;
  fail_next: number;
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

export async function startReceiver(port = 0, host = '127.0.0.1') {
  const received: ReceivedWebhook[] = [];
  let behavior: Behavior = { status: 200, delay_ms: 0, fail_next: 0 };

  function checkSignature(
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
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readBody(request);
    if (received.length >= MAX_RECEIVED) {
      received.shift();
    }
    received.push({
      id: String(request.headers['webhook-id']),
      body: JSON.parse(body),
      signature_valid: checkSignature(request, body),
      received_at: new Date().toISOString(),
    });
    const failing = behavior.fail_next > 0;
    if (failing) {
      behavior.fail_next -= 1;
    }
    await sleep(behavior.delay_ms);
    sendJson(response, failing ? 500 : behavior.status, { received: true });
  }

  const server = createServer((request, response) => {
    const route = `${request.method} ${request.url}`;
    const handle = async () => {
      switch (route) {
        case 'POST /hooks':
          return handleWebhook(request, response);
        case 'POST /control':
          behavior = { ...behavior, ...JSON.parse(await readBody(request)) };
          return sendJson(response, 200, {
            status: behavior.status,
            delay_ms: behavior.delay_ms,
            fail_next: behavior.fail_next,
          });
        case 'GET /received':
          return sendJson(response, 200, { count: received.length, received });
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
    configure(next: Partial<Behavior>): void {
      behavior = { ...behavior, ...next };
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
