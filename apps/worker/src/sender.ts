import {
  checkWebhookUrl,
  signWebhook,
  type TargetPolicy,
} from '@hookline/shared';
import { request, type Dispatcher } from 'undici';

const TIMEOUT_MS = 10_000;
const SNIPPET_BYTES = 1024;

export interface WebhookMessage {
  url: string;
  secrets: string[];
  id: string;
  body: string;
}

export interface SendOptions {
  dispatcher: Dispatcher;
  targetPolicy: TargetPolicy;
}

export interface SendResult {
  startedAt: Date;
  durationMs: number;
  responseStatus: number | null;
  errorCode: string | null;
  responseSnippet: string | null;
}

async function readSnippet(body: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Leaving the loop early closes the stream, so a huge response is not read.
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= SNIPPET_BYTES) {
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, SNIPPET_BYTES).toString('utf8');
}

export async function sendWebhook(
  { url, secrets, id, body }: WebhookMessage,
  { dispatcher, targetPolicy }: SendOptions,
): Promise<SendResult> {
  const startedAt = new Date();
  const timestamp = Math.floor(startedAt.getTime() / 1000);
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  try {
    // An address written in the URL skips DNS, so the dispatcher's lookup
    // never sees it and it is checked here instead.
    checkWebhookUrl(url, targetPolicy);
    // undici's request does not follow redirects, which the delivery policy
    // treats as failures.
    const response = await request(url, {
      dispatcher,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Hookline/0.1',
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': secrets
          .map((secret) => signWebhook({ secret, id, timestamp, body }))
          .join(' '),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const responseSnippet = await readSnippet(response.body);
    return {
      startedAt,
      durationMs: elapsed(),
      responseStatus: response.statusCode,
      errorCode: null,
      responseSnippet,
    };
  } catch (error) {
    const { code, name } = error as NodeJS.ErrnoException;
    return {
      startedAt,
      durationMs: elapsed(),
      responseStatus: null,
      errorCode: code ?? name,
      responseSnippet: null,
    };
  }
}
