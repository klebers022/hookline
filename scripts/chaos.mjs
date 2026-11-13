// The chaos test: publishes EVENTS events into the cluster while it kills,
// one after the other, the delivery worker, the relay, RabbitMQ, an API pod
// and Postgres, with one destination failing at random, one away for a
// while and one that never answers. Then it proves that every event was
// accepted exactly once and that every delivery ended, delivered or dead.
//
//   pnpm k8s:images && pnpm k8s:up chaos
//   pnpm chaos [--events 10000] [--rate 50]
//
// The timeline scales with the time it takes to send the events, so a
// short run (the CI job sends 1,000) goes through the same failures.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';

const { values: options } = parseArgs({
  options: {
    events: { type: 'string', default: '10000' },
    rate: { type: 'string', default: '50' },
  },
});
const EVENTS = Number(options.events);
const RATE = Number(options.rate);
const SEND_SECONDS = EVENTS / RATE;

const URL_BASE = process.env.HOOKLINE_URL ?? 'http://127.0.0.1:8088';
// k6 runs in a container on the cluster's Docker network and goes in
// through the same load balancer as the browser.
const API_IN_NETWORK = 'http://k3d-hookline-serverlb';
const NETWORK = 'k3d-hookline';
const K6_IMAGE = 'grafana/k6:2.3.0';
const RECEIVER_IN_CLUSTER = 'http://test-receiver:4000/hooks';

// The three destinations, each a path of the test receiver.
const DESTINATIONS = {
  // Fails one request in ten at random: retries fix it.
  flaky: {
    behavior: { status: 200, fail_rate: 0.1 },
    types: ['chaos.event', 'chaos.rare'],
  },
  // Answers 503 until OUTAGE_ENDS, then 200: the circuit opens, the
  // deliveries wait without spending tries, and all arrive afterwards.
  outage: {
    behavior: { status: 503 },
    types: ['chaos.event', 'chaos.rare'],
  },
  // Always 500, and only gets the rare type: every delivery is given up
  // on and goes to the dead letter queue, after its tries or, with the
  // circuit open, when its schedule ends.
  broken: { behavior: { status: 500 }, types: ['chaos.rare'] },
};

// When each failure happens, as a share of the sending time.
const at = (share) => Math.round(share * SEND_SECONDS * 1000);
const OUTAGE_ENDS = at(0.6);
const FAULTS = [
  {
    at: at(0.1),
    what: 'Killed the delivery worker (SIGKILL)',
    run: () => killPods('deliver'),
  },
  {
    at: at(0.25),
    what: 'Killed the relay (SIGKILL)',
    run: () => killPods('relay'),
  },
  {
    at: at(0.4),
    what: 'Killed RabbitMQ (SIGKILL)',
    run: () => kubectl('delete', 'pod', 'rabbitmq-0', ...FORCE),
  },
  {
    at: at(0.55),
    what: 'Stopped one API pod (SIGTERM)',
    run: () => kubectl('delete', 'pod', podsOf('api')[0], '--wait=false'),
  },
  {
    at: OUTAGE_ENDS,
    what: 'The outage destination is back',
    run: () => post('/control/outage', { status: 200 }),
  },
  {
    at: at(0.7),
    what: 'Killed Postgres (SIGKILL)',
    run: () => kubectl('delete', 'pod', 'postgres-0', ...FORCE),
  },
];
const FORCE = ['--force', '--grace-period=0', '--wait=false'];

function exec(command, args, { env } = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function kubectl(...args) {
  return exec('kubectl', ['--namespace', 'hookline', ...args]);
}

function podsOf(name) {
  return kubectl(
    'get',
    'pods',
    '--selector',
    `app.kubernetes.io/name=${name}`,
    '--output',
    'jsonpath={.items[*].metadata.name}',
  )
    .split(/\s+/)
    .filter(Boolean);
}

function killPods(name) {
  return kubectl(
    'delete',
    'pod',
    '--selector',
    `app.kubernetes.io/name=${name}`,
    ...FORCE,
  );
}

function sql(query) {
  return exec('kubectl', [
    '--namespace',
    'hookline',
    'exec',
    'postgres-0',
    '--',
    'psql',
    '--username',
    'hookline',
    '--dbname',
    'hookline',
    '--tuples-only',
    '--no-align',
    '--field-separator',
    ',',
    '--command',
    query,
  ])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(','));
}

async function request(path, { method = 'GET', body, apiKey } = {}) {
  const response = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      ...(body && { 'content-type': 'application/json' }),
      ...(apiKey && { authorization: `Bearer ${apiKey}` }),
    },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${method} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

const post = (path, body, apiKey) =>
  request(path, { method: 'POST', body, apiKey });

function elapsed(start) {
  return `${((Date.now() - start) / 1000).toFixed(0).padStart(4)}s`;
}

// The dead letter queue keeps messages for 30 days, so the test compares
// its depth before and after.
function deadLetters() {
  const queues = JSON.parse(
    kubectl(
      'exec',
      'rabbitmq-0',
      '--',
      'rabbitmqctl',
      'list_queues',
      'name',
      'messages',
      '--quiet',
      '--formatter',
      'json',
    ),
  );
  return queues.find((queue) => queue.name === 'deliveries.dlq')?.messages ?? 0;
}

function runK6(apiKey, runId) {
  const out = mkdtempSync(join(tmpdir(), 'hookline-chaos-'));
  // k6 runs as its own user, which must be able to write the summary.
  chmodSync(out, 0o777);
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      NETWORK,
      '--volume',
      `${resolve('load-tests')}:/scripts:ro`,
      '--volume',
      `${out}:/out`,
      // The key goes through the environment, never on the command line.
      ...['API_KEY', 'API_URL', 'RATE', 'EVENTS', 'RUN_ID'].flatMap((name) => [
        '--env',
        name,
      ]),
      K6_IMAGE,
      'run',
      '--quiet',
      '/scripts/chaos.js',
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        API_KEY: apiKey,
        API_URL: API_IN_NETWORK,
        RATE: String(RATE),
        EVENTS: String(EVENTS),
        RUN_ID: runId,
      },
    },
  );
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', (code) => {
      if (code !== 0) {
        fail(new Error(`k6 exited with ${code}`));
        return;
      }
      done(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')));
    });
  });
}

// Refuses to run where the chaos settings are missing, or where Argo CD
// would put the cluster back while the test changes it.
function checkCluster() {
  const settings = kubectl(
    'exec',
    'deploy/deliver',
    '--',
    'printenv',
    'CIRCUIT_OPEN_SECONDS',
  ).trim();
  if (!settings) {
    throw new Error(
      'The cluster lacks the chaos settings: run pnpm k8s:up chaos',
    );
  }
  let automated = '';
  try {
    automated = exec('kubectl', [
      '--namespace',
      'argocd',
      'get',
      'application',
      'hookline',
      '--output',
      'jsonpath={.spec.syncPolicy.automated}',
    ]).trim();
  } catch {
    // No Argo CD in this cluster.
  }
  if (automated) {
    throw new Error(
      'Argo CD syncs this cluster and would undo the chaos overlay: use a cluster without it (pnpm k8s:down, then pnpm k8s:up chaos)',
    );
  }
}

async function waitForDeliveries(projectId, start) {
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    let left;
    try {
      [[left]] = sql(`
        SELECT count(*) FROM deliveries d JOIN events e ON e.id = d.event_id
        WHERE e.project_id = '${projectId}' AND d.status NOT IN ('succeeded', 'dead')`);
    } catch {
      // Postgres is restarting.
    }
    if (left === '0') {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${left} deliveries still in progress after 20 minutes`);
    }
    console.log(`${elapsed(start)}  ${left ?? '?'} deliveries in progress`);
    await sleep(10_000);
  }
}

// ---------------------------------------------------------------------------

checkCluster();
const runId = `chaos-${Date.now()}`;
const created = kubectl(
  'exec',
  'deploy/api',
  '--',
  'node',
  'dist/scripts/create-project.js',
  runId,
);
const projectId = created.match(/Project: (\S+)/)?.[1];
const apiKey = created.match(/API key \(shown only once\): (\S+)/)?.[1];
if (!projectId || !apiKey) {
  throw new Error('No project in the output of create-project');
}

await post('/reset', {});
for (const [name, { behavior, types }] of Object.entries(DESTINATIONS)) {
  await post(`/control/${name}`, behavior);
  await post(
    '/v1/endpoints',
    { url: `${RECEIVER_IN_CLUSTER}/${name}`, event_types: types },
    apiKey,
  );
}
const deadBefore = deadLetters();

console.log(
  `Chaos run ${runId}: ${EVENTS} events at ${RATE}/s for ${SEND_SECONDS.toFixed(0)} s, project ${projectId}`,
);
const start = Date.now();
// A run where a failure could not be caused proves less than it claims.
const faultsFailed = [];
console.log(`Started at ${new Date(start).toISOString()}`);
const timers = FAULTS.map((fault) =>
  setTimeout(async () => {
    try {
      await fault.run();
      console.log(`${elapsed(start)}  ${fault.what}`);
    } catch (error) {
      faultsFailed.push(fault.what);
      console.log(`${elapsed(start)}  FAILED: ${fault.what}: ${error.message}`);
    }
  }, fault.at),
);
let k6;
try {
  k6 = await runK6(apiKey, runId);
} finally {
  timers.forEach(clearTimeout);
}
console.log(`${elapsed(start)}  Sending done`);

await waitForDeliveries(projectId, start);
const end = Date.now();
console.log(`${elapsed(start)}  Every delivery ended`);
console.log(`Ended at ${new Date(end).toISOString()}\n`);

// --- The proof ---------------------------------------------------------------

const [[events, distinct, rare]] = sql(`
  SELECT count(*), count(DISTINCT payload->>'n'),
         count(*) FILTER (WHERE type = 'chaos.rare')
  FROM events WHERE project_id = '${projectId}'`);
const byDestination = Object.fromEntries(
  sql(`
    SELECT substring(ep.url FROM '[^/]+$'), count(*),
           count(*) FILTER (WHERE d.status = 'succeeded'),
           count(*) FILTER (WHERE d.status = 'dead'),
           sum(d.attempt_count)
    FROM deliveries d
    JOIN endpoints ep ON ep.id = d.endpoint_id
    JOIN events e ON e.id = d.event_id
    WHERE e.project_id = '${projectId}'
    GROUP BY 1`).map(([name, total, succeeded, dead, attempts]) => [
    name,
    {
      total: Number(total),
      succeeded: Number(succeeded),
      dead: Number(dead),
      attempts: Number(attempts),
    },
  ]),
);
const [[unpublished]] = sql(`
  SELECT count(*) FROM outbox o
  JOIN deliveries d ON d.id = o.delivery_id
  JOIN events e ON e.id = d.event_id
  WHERE e.project_id = '${projectId}' AND o.published_at IS NULL`);
// Deliveries given up on because their schedule ended with the circuit open.
const [[expired]] = sql(`
  SELECT count(*) FROM delivery_attempts a
  JOIN deliveries d ON d.id = a.delivery_id
  JOIN events e ON e.id = d.event_id
  WHERE e.project_id = '${projectId}' AND a.error_code = 'DEADLINE_EXCEEDED'`);
const received = await request('/stats');
const deadAdded = deadLetters() - deadBefore;

const checks = [];
function check(description, ok, detail) {
  checks.push(ok);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${description}${detail ? `: ${detail}` : ''}`,
  );
}

console.log(
  `k6: ${k6.accepted} events accepted, ${k6.retries} requests retried after a failure, ${k6.gave_up} given up, ${k6.dropped} not sent in time\n`,
);
console.log(
  'destination   deliveries  succeeded       dead   attempts  received  duplicates',
);
for (const name of Object.keys(DESTINATIONS)) {
  const row = byDestination[name] ?? {
    total: 0,
    succeeded: 0,
    dead: 0,
    attempts: 0,
  };
  const seen = received[name] ?? { unique: 0, duplicates: 0 };
  console.log(
    `${name.padEnd(12)}${String(row.total).padStart(12)}${String(row.succeeded).padStart(11)}${String(row.dead).padStart(11)}${String(row.attempts).padStart(11)}${String(seen.unique).padStart(10)}${String(seen.duplicates).padStart(12)}`,
  );
}
console.log();

const n = Number(events);
check(
  'Every failure was caused',
  faultsFailed.length === 0,
  faultsFailed.join('; ') || `${FAULTS.length} of ${FAULTS.length}`,
);
check(
  'Every event sent was accepted',
  k6.gave_up === 0,
  `${k6.gave_up} given up`,
);
check(
  'Every accepted event is in the database, once',
  n === k6.accepted && Number(distinct) === n,
  `${k6.accepted} accepted, ${events} rows, ${distinct} distinct`,
);
const flaky = byDestination.flaky;
const outage = byDestination.outage;
const broken = byDestination.broken;
check(
  'Every delivery ended',
  flaky?.total === n && outage?.total === n && broken?.total === Number(rare),
  `${n} + ${n} + ${rare} expected`,
);
check(
  'The flaky destination got all of its deliveries',
  flaky?.succeeded === n && received.flaky?.unique === n,
  `${flaky?.succeeded} succeeded, ${received.flaky?.unique} received`,
);
check(
  'The destination that came back got all of its deliveries',
  outage?.succeeded === n && received.outage?.unique === n,
  `${outage?.succeeded} succeeded, ${received.outage?.unique} received`,
);
check(
  'Every delivery to the broken destination is dead',
  broken?.dead === Number(rare),
  `${broken?.dead} dead, ${expired} of them when the schedule ended with the circuit open`,
);
check(
  'The dead letter queue got them',
  deadAdded >= Number(rare),
  `${deadAdded} added`,
);
check(
  'No outbox row left unpublished',
  unpublished === '0',
  `${unpublished} left`,
);

console.log(
  `\nDuplicates are allowed (at-least-once delivery) and counted above. Timeline: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}`,
);
if (checks.includes(false)) {
  process.exitCode = 1;
}
