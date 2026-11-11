// End-to-end check of the stack running in containers: a signed webhook
// reaches the test receiver, and stopping the delivery worker in the middle
// of a slow delivery still records it. With --k8s it checks the k3d cluster
// (pnpm k8s:up) instead of the compose stack (pnpm stack:up).
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const K8S = process.argv.includes('--k8s');
// In the cluster, the dashboard's address also reaches the API (through
// nginx's /v1) and the receiver's control routes.
const API =
  process.env.API_URL ??
  (K8S ? 'http://127.0.0.1:8088' : 'http://127.0.0.1:3000');
const RECEIVER =
  process.env.RECEIVER_URL ??
  (K8S ? 'http://127.0.0.1:8088' : 'http://127.0.0.1:4000');
// The address the delivery worker uses, inside the compose network or the
// cluster: the same name in both.
const RECEIVER_IN_NETWORK = 'http://test-receiver:4000/hooks';

function exec(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    // Progress goes to stderr; a failure's error carries it.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function compose(...args) {
  return exec('docker', ['compose', '--profile', 'app', ...args]);
}

function kubectl(...args) {
  return exec('kubectl', ['--namespace', 'hookline', ...args]);
}

// Runs a command in the image of a service: the API's, for its scripts.
function runIn(service, ...command) {
  return K8S
    ? kubectl('exec', `deploy/${service}`, '--', ...command)
    : compose('run', '--rm', '--no-deps', '-T', service, ...command);
}

// Runs a command inside the service's running container.
function execIn(service, ...command) {
  return K8S
    ? kubectl('exec', `deploy/${service}`, '--', ...command)
    : compose('exec', '-T', service, ...command);
}

// Stops the delivery worker and returns once it has exited. In the cluster,
// deleting the pod waits for it to end, and the Deployment starts another.
function stopDeliver() {
  if (K8S) {
    kubectl(
      'delete',
      'pod',
      '--selector',
      'app.kubernetes.io/name=deliver',
      '--wait=true',
    );
  } else {
    compose('stop', 'deliver');
  }
}

function startDeliver() {
  if (K8S) {
    kubectl('rollout', 'status', 'deploy/deliver', '--timeout=120s');
  } else {
    compose('start', 'deliver');
  }
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

const created = runIn(
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

// Reads a process's metrics from inside its container: the ops port is not
// published outside the compose network or the cluster.
function metric(service, name, labels) {
  const text = execIn(
    service,
    'node',
    '-e',
    "fetch('http://127.0.0.1:9464/metrics').then((r) => r.text()).then((t) => process.stdout.write(t))",
  );
  const line = text
    .split('\n')
    .find(
      (l) =>
        l.startsWith(`${name}{`) &&
        Object.entries(labels).every(([key, value]) =>
          l.includes(`${key}="${value}"`),
        ),
    );
  return line ? Number(line.split(' ').at(-1)) : 0;
}

const succeededBefore = metric('deliver', 'hookline_delivery_attempts_total', {
  outcome: 'succeeded',
});

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

const succeededAfter = metric('deliver', 'hookline_delivery_attempts_total', {
  outcome: 'succeeded',
});
if (succeededAfter !== succeededBefore + 1) {
  throw new Error(
    `Succeeded attempts went from ${succeededBefore} to ${succeededAfter}, not up by 1`,
  );
}
if (metric('api', 'hookline_events_accepted_total', {}) < 1) {
  throw new Error('The API did not count the accepted event');
}
step('The metrics counted the event and the succeeded attempt');

// The receiver records a webhook as it arrives and answers 5 seconds
// later, so the worker is stopped while the request is in flight.
await request(`${RECEIVER}/control`, {
  method: 'POST',
  body: { delay_ms: 5000 },
});
const slow = await publish('slow');
await waitFor('the slow webhook to arrive', () => arrived(slow));
const stopStarted = Date.now();
stopDeliver();
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
  `Stopping the worker waited ${stopSeconds.toFixed(1)}s for the delivery in flight, recorded as succeeded`,
);

startDeliver();
step('Restarted the delivery worker');

// Nothing here is old enough to delete; this checks the script runs.
const retention = runIn('api', 'node', 'dist/scripts/retention.js');
if (!/Deleted \d+ finished events/.test(retention)) {
  throw new Error(`Unexpected retention output:\n${retention}`);
}
step(`Ran the retention script: ${retention.trim()}`);
console.log('Smoke test passed');
