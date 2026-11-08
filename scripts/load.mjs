// Runs a k6 scenario against the stack in containers and reports the
// numbers for docs/capacity.md. Needs pnpm stack:up and pnpm obs:up.
//
//   node scripts/load.mjs ingest       publish rate climbing to the limit
//   node scripts/load.mjs end-to-end   steady rate, every delivery checked
//
// k6 options pass through the environment: RATE and DURATION for
// end-to-end, MAX_RATE, RAMP and MAX_VUS for ingest.
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SCENARIOS = ['ingest', 'end-to-end'];
const scenario = process.argv[2];
if (!SCENARIOS.includes(scenario)) {
  console.error(`Usage: node scripts/load.mjs <${SCENARIOS.join('|')}>`);
  process.exit(1);
}

const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
const RECEIVER = process.env.RECEIVER_URL ?? 'http://127.0.0.1:4000';
const API = process.env.API_URL ?? 'http://127.0.0.1:3000';

// Limits high enough that the load test measures the stack, not them.
const loadEnv = {
  ...process.env,
  RATE_LIMIT_PER_MINUTE: '100000000',
  ENDPOINT_RATE_LIMIT_PER_SECOND: '1000000',
};

function compose(args, env = loadEnv) {
  return execFileSync('docker', ['compose', '--profile', 'app', ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sql(query) {
  return compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    process.env.POSTGRES_USER ?? 'hookline',
    '-d',
    process.env.POSTGRES_DB ?? 'hookline',
    '-tA',
    '-F',
    ',',
    '-c',
    query,
  ])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(','));
}

async function prometheus(path, params) {
  const url = new URL(`/api/v1/${path}`, PROMETHEUS);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const body = await (await fetch(url)).json();
  if (body.status !== 'success') {
    throw new Error(`Prometheus: ${JSON.stringify(body)}`);
  }
  return body.data.result;
}

async function post(url, body, apiKey) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey && { authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${url}: ${response.status} ${await response.text()}`);
  }
}

try {
  await fetch(`${PROMETHEUS}/-/ready`);
} catch {
  console.error('Prometheus is not running: start it with pnpm obs:up.');
  process.exit(1);
}

console.log(
  '- Raising the API and endpoint rate limits (pnpm stack:up restores them)',
);
// Recreates only what the new limits change, and makes sure the rest of
// the stack is up.
compose(['up', '-d', '--wait', '--no-build']);

const created = compose([
  'run',
  '--rm',
  '--no-deps',
  '-T',
  'api',
  'node',
  'dist/scripts/create-project.js',
  `load ${scenario} ${new Date().toISOString()}`,
]);
const projectId = created.match(/Project: (\S+)/)?.[1];
const apiKey = created.match(/API key \(shown only once\): (\S+)/)?.[1];
if (!projectId || !apiKey) {
  throw new Error(`No project in the output:\n${created}`);
}

// One endpoint, the test receiver answering 200 at once, so each event
// makes one delivery and the endpoint is never the bottleneck.
await post(`${RECEIVER}/control`, { status: 200, delay_ms: 0, fail_next: 0 });
await post(
  `${API}/v1/endpoints`,
  { url: 'http://test-receiver:4000/hooks', event_types: ['load.test'] },
  apiKey,
);
console.log(`- Created project ${projectId} with one endpoint`);

const testId = `${scenario}-${Date.now()}`;
const started = Date.now() / 1000;
// The key goes to k6 through the environment, never on the command line.
const k6 = spawnSync(
  'docker',
  [
    'compose',
    '--profile',
    'load',
    'run',
    '--rm',
    '-e',
    'API_KEY',
    ...['RATE', 'DURATION', 'MAX_RATE', 'RAMP', 'MAX_VUS'].flatMap((name) =>
      process.env[name] ? ['-e', name] : [],
    ),
    'k6',
    'run',
    '--out',
    'experimental-prometheus-rw',
    '--tag',
    `testid=${testId}`,
    `/scripts/${scenario}.js`,
  ],
  { stdio: 'inherit', env: { ...loadEnv, API_KEY: apiKey } },
);
const ended = Date.now() / 1000;
// k6 exits 99 when a threshold fails, which is a result here, not an error.
if (k6.status !== 0 && k6.status !== 99) {
  throw new Error(`k6 exited with ${k6.status}`);
}

if (scenario === 'ingest') {
  await reportIngest(started, ended, testId);
} else {
  await reportEndToEnd(projectId, started);
}

// Per 15 s: the rate k6 offered, the events per second the API accepted,
// its p99 for POST /v1/events and its error responses. Past capacity, the
// accepted rate falls behind the offered one and the p99 climbs.
async function reportIngest(start, end, test) {
  // Lets Prometheus scrape the last seconds of the run.
  await sleep(10_000);
  const range = { start: start + 15, end, step: 15 };
  const series = async (query) =>
    new Map(
      (
        (await prometheus('query_range', { query, ...range }))[0]?.values ?? []
      ).map(([time, value]) => [time, Number(value)]),
    );
  const [offered, rate, p99, errors] = await Promise.all([
    // Iterations k6 started, plus those it had no free VU to start.
    series(
      `sum(rate(k6_iterations_total{testid="${test}"}[30s])) + (sum(rate(k6_dropped_iterations_total{testid="${test}"}[30s])) or vector(0))`,
    ),
    series('sum(rate(hookline_events_accepted_total[30s]))'),
    series(
      'histogram_quantile(0.99, sum by (le) (rate(hookline_http_request_duration_seconds_bucket{method="POST",route="/v1/events"}[30s])))',
    ),
    series(
      'sum(rate(hookline_http_request_duration_seconds_count{method="POST",route="/v1/events",status_class!="2xx"}[30s])) or vector(0)',
    ),
  ]);

  console.log('\n  time   offered/s  accepted/s   p99 (ms)   errors/s');
  let best = 0;
  for (const [time, value] of rate) {
    const latency = p99.get(time) ?? NaN;
    const failed = errors.get(time) ?? 0;
    if (latency < 0.2 && failed === 0) {
      best = Math.max(best, value);
    }
    console.log(
      `  ${String(Math.round(time - start)).padStart(4)}s  ${(offered.get(time) ?? 0).toFixed(0).padStart(10)}  ${value.toFixed(0).padStart(10)}  ${(latency * 1000).toFixed(0).padStart(9)}  ${failed.toFixed(1).padStart(9)}`,
    );
  }
  console.log(
    `\nHighest rate with p99 under 200 ms and no errors: ${best.toFixed(0)} events/s`,
  );
}

// Waits for every delivery to end, then measures from the database: the
// rows are the proof that nothing was lost.
async function reportEndToEnd(project, start) {
  const pending = () =>
    Number(
      sql(`SELECT count(*) FROM deliveries d JOIN events e ON e.id = d.event_id
           WHERE e.project_id = '${project}'
             AND d.status NOT IN ('succeeded', 'dead')`)[0][0],
    );
  console.log('\n- Waiting for every delivery to end');
  const deadline = Date.now() + 15 * 60_000;
  for (let left = pending(); left > 0; left = pending()) {
    if (Date.now() > deadline) {
      throw new Error(`${left} deliveries still in progress after 15 minutes`);
    }
    process.stdout.write(`  ${left} in progress\r`);
    await sleep(2000);
  }

  const [[events, deliveries, succeeded, dead, unpublished, drainSeconds]] =
    sql(`
    SELECT
      (SELECT count(*) FROM events WHERE project_id = '${project}'),
      count(*),
      count(*) FILTER (WHERE d.status = 'succeeded'),
      count(*) FILTER (WHERE d.status = 'dead'),
      (SELECT count(*) FROM outbox o JOIN deliveries d2 ON d2.id = o.delivery_id
        JOIN events e2 ON e2.id = d2.event_id
        WHERE e2.project_id = '${project}' AND o.published_at IS NULL),
      round(extract(epoch FROM max(d.delivered_at) - min(e.created_at))::numeric, 1)
    FROM deliveries d JOIN events e ON e.id = d.event_id
    WHERE e.project_id = '${project}'`);
  const [[attempts, p50, p99, max, withinSlo]] = sql(`
    SELECT count(*),
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY delay)::numeric * 1000),
      round(percentile_cont(0.99) WITHIN GROUP (ORDER BY delay)::numeric * 1000),
      round(max(delay)::numeric * 1000),
      round(100.0 * count(*) FILTER (WHERE delay <= 5) / count(*), 3)
    FROM (
      SELECT extract(epoch FROM a.started_at - e.created_at) AS delay
      FROM delivery_attempts a
      JOIN deliveries d ON d.id = a.delivery_id
      JOIN events e ON e.id = d.event_id
      WHERE e.project_id = '${project}' AND a.attempt_number = 1
    ) first_attempts`);
  const [[retries]] = sql(`
    SELECT count(*) FROM delivery_attempts a
    JOIN deliveries d ON d.id = a.delivery_id
    JOIN events e ON e.id = d.event_id
    WHERE e.project_id = '${project}' AND a.attempt_number > 1`);

  console.log(`
Events accepted:            ${events}
Deliveries:                 ${deliveries} (${succeeded} succeeded, ${dead} dead)
Unpublished outbox rows:    ${unpublished}
Retried attempts:           ${retries}
First attempts:             ${attempts}
Delay to first attempt:     p50 ${p50} ms, p99 ${p99} ms, max ${max} ms
Within the 5 s SLO:         ${withinSlo}%
From first event to last delivery: ${drainSeconds} s (${(Number(deliveries) / Number(drainSeconds)).toFixed(0)} deliveries/s)
Test started at:            ${new Date(start * 1000).toISOString()}`);

  if (Number(events) !== Number(deliveries) || Number(unpublished) !== 0) {
    throw new Error('Some events have no finished delivery');
  }
}
