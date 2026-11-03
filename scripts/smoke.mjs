// End-to-end check of the stack running in containers (pnpm stack:up):
// a signed webhook reaches the test receiver, and stopping the delivery
// worker in the middle of a slow delivery still records it.
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const RECEIVER = process.env.RECEIVER_URL ?? 'http://127.0.0.1:4000';
// The address the delivery worker uses, inside the compose network.
const RECEIVER_IN_NETWORK = 'http://test-receiver:4000/hooks';

function compose(...args) {
  return execFileSync('docker', ['compose', '--profile', 'app', ...args], {
    encoding: 'utf8',
    // Progress goes to stderr; a failure's error carries it.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function request(url, { method = 'GET', body, apiKey } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body && { 'content-type': 'application/json' }),
      ...(apiKey && { authorization: `Bearer ${apiKey}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${url}: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

async function waitFor(description, check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await sleep(200);
  }
}

function step(message) {
  console.log(`- ${message}`);
}

const created = compose(
  'run',
  '--rm',
  '--no-deps',
  '-T',
  'api',
  'node',
  'dist/scripts/create-project.js',
  `smoke ${new Date().toISOString()}`,
);
const apiKey = created.match(/API key \(shown only once\): (\S+)/)?.[1];
if (!apiKey) {
  throw new Error(`No API key in the output:\n${created}`);
}
step('Created a project');

const endpoint = await request(`${API}/v1/endpoints`, {
  method: 'POST',
  apiKey,
  body: { url: RECEIVER_IN_NETWORK, event_types: ['smoke.test'] },
});
await request(`${RECEIVER}/control`, {
  method: 'POST',
  body: { secret: endpoint.secret, status: 200, delay_ms: 0, fail_next: 0 },
});
step('Registered the test receiver as an endpoint');

async function publish(label) {
  const event = await request(`${API}/v1/events`, {
    method: 'POST',
    apiKey,
    body: { type: 'smoke.test', payload: { label } },
  });
  return event.id;
}

// The webhook-id header is the event id.
async function arrived(eventId) {
  const { received } = await request(`${RECEIVER}/received`);
  return received.find((webhook) => webhook.id === eventId);
}

async function delivery(eventId) {
  const event = await request(`${API}/v1/events/${eventId}`, { apiKey });
  return request(`${API}/v1/deliveries/${event.deliveries[0].id}`, {
    apiKey,
  });
}

const first = await publish('first');
const webhook = await waitFor('the first webhook', () => arrived(first));
if (webhook.signature_valid !== true) {
  throw new Error('The webhook signature did not verify');
}
await waitFor(
  'the first delivery to succeed',
  async () => (await delivery(first)).status === 'succeeded',
);
step('A published event arrived signed and was recorded as succeeded');

// The receiver records a webhook as it arrives and answers 5 seconds
// later, so the worker is stopped while the request is in flight.
await request(`${RECEIVER}/control`, {
  method: 'POST',
  body: { delay_ms: 5000 },
});
const slow = await publish('slow');
await waitFor('the slow webhook to arrive', () => arrived(slow));
const stopStarted = Date.now();
compose('stop', 'deliver');
const stopSeconds = (Date.now() - stopStarted) / 1000;
await request(`${RECEIVER}/control`, { method: 'POST', body: { delay_ms: 0 } });

const stopped = await delivery(slow);
const attempt = stopped.attempts[0];
if (
  stopped.status !== 'succeeded' ||
  stopped.attempts.length !== 1 ||
  attempt.response_status !== 200
) {
  throw new Error(
    `The delivery in flight was not recorded: ${JSON.stringify(stopped)}`,
  );
}
step(
  `docker compose stop waited ${stopSeconds.toFixed(1)}s for the delivery in flight, recorded as succeeded`,
);

compose('start', 'deliver');
step('Restarted the delivery worker');
console.log('Smoke test passed');
