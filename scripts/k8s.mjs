// The local Kubernetes cluster (k3d), in a few commands:
//   up [overlay]  creates the cluster if needed, the secrets, and applies the
//                 overlay (local by default; ci in the CI job)
//   down          deletes the cluster and everything in it
//   images        builds the four images as hookline-*:ci and imports them
//                 into the cluster, creating it if needed
//   project NAME  creates a project and prints its API key
//   obs           applies the observability stack
//   obs-check     checks that it sees the app: every scrape target up, the
//                 alert rules loaded, traces in Tempo and logs in Loki
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CLUSTER = 'hookline';
const NAMESPACE = 'hookline';
const IMAGES = ['api', 'worker', 'web', 'test-receiver'];

function run(command, args, { quiet = false, input } = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    input,
    stdio: [
      input === undefined ? 'ignore' : 'pipe',
      quiet ? 'pipe' : 'inherit',
      'inherit',
    ],
  });
}

function kubectl(...args) {
  return run('kubectl', ['--namespace', NAMESPACE, ...args]);
}

function clusterExists() {
  const clusters = JSON.parse(
    run('k3d', ['cluster', 'list', '--output', 'json'], { quiet: true }),
  );
  return clusters.some((cluster) => cluster.name === CLUSTER);
}

// Random passwords and encryption key, created once per cluster and never
// written to the repository. Sealed Secrets replaces this in phase 7.
function ensureSecrets() {
  const existing = run(
    'kubectl',
    [
      '--namespace',
      NAMESPACE,
      'get',
      'secret',
      'hookline-secrets',
      '--ignore-not-found',
      '--output',
      'name',
    ],
    { quiet: true },
  );
  if (existing.trim()) {
    return;
  }
  const secret = run(
    'kubectl',
    [
      '--namespace',
      NAMESPACE,
      'create',
      'secret',
      'generic',
      'hookline-secrets',
      `--from-literal=POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
      `--from-literal=RABBITMQ_PASSWORD=${randomBytes(24).toString('hex')}`,
      `--from-literal=ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
      '--dry-run=client',
      '--output=yaml',
    ],
    { quiet: true },
  );
  run('kubectl', ['apply', '--filename', '-'], { quiet: true, input: secret });
  console.log('Created the hookline-secrets Secret');
}

function ensureCluster() {
  if (!clusterExists()) {
    run('k3d', [
      'cluster',
      'create',
      '--config',
      'infra/k8s/k3d.yaml',
      '--wait',
    ]);
  }
}

// Waits until every StatefulSet and Deployment in the namespace is ready.
function waitForRollouts(namespace) {
  const workloads = run(
    'kubectl',
    [
      '--namespace',
      namespace,
      'get',
      'statefulset,deployment',
      '--output',
      'name',
    ],
    { quiet: true },
  );
  for (const workload of workloads.split(/\s+/).filter(Boolean)) {
    run('kubectl', [
      '--namespace',
      namespace,
      'rollout',
      'status',
      workload,
      '--timeout=300s',
    ]);
  }
}

function up(overlay = 'local') {
  ensureCluster();
  run('kubectl', ['apply', '--filename', 'infra/k8s/base/namespace.yaml']);
  ensureSecrets();
  // A Job's pod template cannot change, so the migration starts over.
  kubectl('delete', 'job', 'migrate', '--ignore-not-found');
  run('kubectl', ['apply', '--kustomize', `infra/k8s/overlays/${overlay}`]);
  kubectl('wait', 'job/migrate', '--for=condition=complete', '--timeout=300s');
  waitForRollouts(NAMESPACE);
  console.log('The stack is up: http://hookline.localhost:8088');
}

function images() {
  ensureCluster();
  for (const target of IMAGES) {
    run('docker', [
      'build',
      '--target',
      target,
      '--tag',
      `hookline-${target}:ci`,
      '.',
    ]);
  }
  run('k3d', [
    'image',
    'import',
    '--cluster',
    CLUSTER,
    ...IMAGES.map((t) => `hookline-${t}:ci`),
  ]);
}

function obs() {
  run('kubectl', ['apply', '--kustomize', 'infra/observability']);
  waitForRollouts('observability');
  console.log('Grafana is up: http://grafana.hookline.localhost:8088');
}

// Opens a local port to a Service until the callback returns. A port-forward
// reaches the pod directly, past the network policies, as a person
// debugging would.
async function withPortForward(service, localPort, port, callback) {
  const forward = spawn(
    'kubectl',
    [
      '--namespace',
      'observability',
      'port-forward',
      `service/${service}`,
      `${localPort}:${port}`,
    ],
    { stdio: 'ignore' },
  );
  try {
    return await callback(`http://127.0.0.1:${localPort}`);
  } finally {
    forward.kill();
  }
}

// Retries the check for up to a minute: the first scrape, trace flush or
// log push may not have happened yet.
async function eventually(description, check) {
  const deadline = Date.now() + 60_000;
  let last;
  for (;;) {
    try {
      const result = await check();
      if (result) {
        console.log(`- ${description}`);
        return;
      }
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${description}`, { cause: last });
    }
    await sleep(2000);
  }
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`);
  }
  return response.json();
}

async function obsCheck() {
  await withPortForward('prometheus', 19090, 9090, async (base) => {
    await eventually(
      'Prometheus scrapes every API, relay and deliver pod and RabbitMQ',
      async () => {
        const { data } = await getJson(`${base}/api/v1/query?query=up`);
        const up = (job) =>
          data.result.filter(
            (series) => series.metric.job === job && series.value[1] === '1',
          ).length;
        // Two API pods, one relay, one deliver.
        return up('hookline') >= 4 && up('rabbitmq') === 1;
      },
    );
    await eventually('Prometheus loaded the alert rules', async () => {
      const { data } = await getJson(`${base}/api/v1/rules`);
      return data.groups.length > 0;
    });
  });
  await withPortForward('tempo', 13200, 3200, (base) =>
    eventually('Tempo has traces from the delivery worker', async () => {
      const { traces } = await getJson(
        `${base}/api/search?tags=${encodeURIComponent('service.name=hookline-deliver')}&limit=5`,
      );
      return traces?.length > 0;
    }),
  );
  await withPortForward('loki', 13100, 3100, (base) =>
    eventually('Loki has log lines from the API', async () => {
      const query = encodeURIComponent('{service="api"}');
      const { data } = await getJson(
        `${base}/loki/api/v1/query_range?query=${query}&since=1h&limit=5`,
      );
      return data.result.length > 0;
    }),
  );
  console.log('Observability check passed');
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'up':
    up(args[0]);
    break;
  case 'down':
    run('k3d', ['cluster', 'delete', CLUSTER]);
    break;
  case 'images':
    images();
    break;
  case 'project':
    kubectl(
      'exec',
      'deploy/api',
      '--',
      'node',
      'dist/scripts/create-project.js',
      args.join(' ') || 'local',
    );
    break;
  case 'obs':
    obs();
    break;
  case 'obs-check':
    await obsCheck();
    break;
  default:
    console.error(
      'Usage: node scripts/k8s.mjs up [overlay] | down | images | project NAME | obs | obs-check',
    );
    process.exit(1);
}
