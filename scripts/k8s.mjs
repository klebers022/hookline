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
//   argocd        installs Argo CD and the root application, which syncs
//                 the stack from main from then on
//   bump          pins the local overlay to the images of the latest main
//   backup        runs the nightly database backup now
//   restore-test  takes a backup, restores it into a throwaway database and
//                 compares every table's row count with the live one
//   restore [NAME] restores the latest backup, or the one named, over the
//                 live database (see docs/runbooks/restore.md first)
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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

// Random passwords and keys, created once per cluster and never written to
// the repository. Sealed Secrets replaces this in phase 7. A Secret that
// already exists is left alone, so the passwords stay the ones the
// databases were created with.
function ensureSecret(name, literals) {
  const existing = run(
    'kubectl',
    [
      '--namespace',
      NAMESPACE,
      'get',
      'secret',
      name,
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
      name,
      ...Object.entries(literals).map(
        ([key, value]) => `--from-literal=${key}=${value}`,
      ),
      '--dry-run=client',
      '--output=yaml',
    ],
    { quiet: true },
  );
  run('kubectl', ['apply', '--filename', '-'], { quiet: true, input: secret });
  console.log(`Created the ${name} Secret`);
}

function ensureSecrets() {
  ensureSecret('hookline-secrets', {
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    RABBITMQ_PASSWORD: randomBytes(24).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  // The keys of the backup store (ADR 14).
  ensureSecret('hookline-backup', {
    ACCESS_KEY_ID: `hookline-${randomBytes(6).toString('hex')}`,
    SECRET_ACCESS_KEY: randomBytes(24).toString('hex'),
  });
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

function argocd() {
  // The CRDs are too big for the annotation a client-side apply keeps.
  run('kubectl', [
    'apply',
    '--server-side',
    '--force-conflicts',
    '--kustomize',
    'infra/k8s/argocd/install',
  ]);
  waitForRollouts('argocd');
  run('kubectl', ['apply', '--filename', 'infra/k8s/argocd/root.yaml']);
  console.log(
    'Argo CD is up: http://argocd.hookline.localhost:8088 (read-only without a login)',
  );
  console.log(
    'The admin password is in the argocd-initial-admin-secret Secret, in the argocd namespace.',
  );
}

// Waits for a Job to succeed or fail, and returns whether it succeeded.
async function waitForJob(name, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = JSON.parse(
      run(
        'kubectl',
        [
          '--namespace',
          NAMESPACE,
          'get',
          'job',
          name,
          '--output',
          'jsonpath={.status}',
        ],
        { quiet: true },
      ) || '{}',
    );
    if (status.succeeded) {
      return true;
    }
    if (status.failed) {
      return false;
    }
    await sleep(2000);
  }
  throw new Error(`Job ${name} did not finish in ${timeoutMs / 1000} s`);
}

function jobLogs(name) {
  return run(
    'kubectl',
    ['--namespace', NAMESPACE, 'logs', `job/${name}`, '--all-containers'],
    { quiet: true },
  );
}

// Runs the nightly backup now, from the CronJob's own template, so this
// tests exactly what runs every night.
async function backup() {
  const name = `backup-manual-${Date.now()}`;
  kubectl('create', 'job', name, '--from=cronjob/backup');
  const succeeded = await waitForJob(name);
  process.stdout.write(jobLogs(name));
  if (!succeeded) {
    throw new Error(`The backup job ${name} failed`);
  }
}

// "count <table> <rows>" lines, from the live database or the restored one.
const COUNT_TABLES = `
  SELECT 'count', table_name,
    (xpath('/row/c/text()', query_to_xml(
      format('SELECT count(*) AS c FROM public.%I', table_name),
      false, true, '')))[1]::text
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name`;

function parseCounts(output) {
  const counts = new Map();
  for (const line of output.split('\n')) {
    const [tag, table, rows] = line.trim().split(' ');
    if (tag === 'count' && table) {
      counts.set(table, Number(rows));
    }
  }
  return counts;
}

// Takes a backup, restores it into a throwaway database (the restore-test
// Job) and compares the row count of every table with the live database.
// Run it while nothing writes, or the live counts move on from the copy.
async function restoreTest() {
  await backup();
  kubectl('delete', 'job', 'restore-test', '--ignore-not-found', '--wait');
  run('kubectl', ['apply', '--filename', 'infra/k8s/jobs/restore-test.yaml']);
  const succeeded = await waitForJob('restore-test');
  const logs = jobLogs('restore-test');
  if (!succeeded) {
    process.stdout.write(logs);
    throw new Error('The restore failed');
  }
  const restored = parseCounts(logs);
  const live = parseCounts(
    run(
      'kubectl',
      [
        '--namespace',
        NAMESPACE,
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
        ' ',
        '--command',
        COUNT_TABLES,
      ],
      { quiet: true },
    ),
  );
  console.log(logs.split('\n').find((line) => line.startsWith('restored')));
  console.log(
    `\n${'table'.padEnd(20)} ${'live'.padStart(9)} ${'restored'.padStart(10)}`,
  );
  let same = live.size > 0;
  for (const table of new Set([...live.keys(), ...restored.keys()])) {
    const ok = live.get(table) === restored.get(table);
    same &&= ok;
    console.log(
      `${table.padEnd(20)} ${String(live.get(table) ?? '-').padStart(9)} ${String(restored.get(table) ?? '-').padStart(10)}${ok ? '' : '  DIFFERENT'}`,
    );
  }
  if (!same) {
    throw new Error('The restored copy does not match the live database');
  }
  console.log('\nThe restored copy matches the live database');
}

// The processes that write to the database. A restore stops them, so
// nothing writes while the tables are replaced.
const WRITERS = ['api', 'relay', 'deliver'];

// Restores a backup over the live database: the latest one, or the one
// named. Everything written after that backup is lost
// (docs/runbooks/restore.md). The writers are stopped first and started
// again afterwards, even when the restore fails.
async function restore(backupName = '') {
  const argocd = run(
    'kubectl',
    [
      'get',
      'crd',
      'applications.argoproj.io',
      '--ignore-not-found',
      '--output',
      'name',
    ],
    { quiet: true },
  ).trim();
  const automated =
    argocd &&
    run(
      'kubectl',
      [
        '--namespace',
        'argocd',
        'get',
        'application',
        'hookline',
        '--ignore-not-found',
        '--output',
        'jsonpath={.spec.syncPolicy.automated}',
      ],
      { quiet: true },
    ).trim();
  if (automated) {
    throw new Error(
      'Argo CD would start the stopped processes again: turn off automated sync on the hookline Application first',
    );
  }
  const replicas = Object.fromEntries(
    WRITERS.map((name) => [
      name,
      run(
        'kubectl',
        [
          '--namespace',
          NAMESPACE,
          'get',
          'deployment',
          name,
          '--output',
          'jsonpath={.spec.replicas}',
        ],
        { quiet: true },
      ).trim(),
    ]),
  );
  for (const name of WRITERS) {
    kubectl('scale', `deployment/${name}`, '--replicas=0');
  }
  for (const name of WRITERS) {
    kubectl(
      'wait',
      'pod',
      '--selector',
      `app.kubernetes.io/name=${name}`,
      '--for=delete',
      '--timeout=120s',
    );
  }
  try {
    kubectl('delete', 'job', 'restore', '--ignore-not-found', '--wait');
    const manifest = readFileSync('infra/k8s/jobs/restore.yaml', 'utf8');
    const named = manifest.replace(
      "- name: BACKUP\n              value: ''",
      `- name: BACKUP\n              value: '${backupName.replace(/[^\w.-]/g, '')}'`,
    );
    run('kubectl', ['apply', '--filename', '-'], { input: named });
    const succeeded = await waitForJob('restore', 600_000);
    process.stdout.write(jobLogs('restore'));
    if (!succeeded) {
      throw new Error('The restore failed; the database was left as it was');
    }
  } finally {
    for (const name of WRITERS) {
      kubectl('scale', `deployment/${name}`, `--replicas=${replicas[name]}`);
    }
    waitForRollouts(NAMESPACE);
  }
}

const OVERLAY = 'infra/k8s/overlays/local/kustomization.yaml';
const REGISTRY = 'ghcr.io';
const OWNER = 'klebers022';

// Asks GHCR, anonymously, whether an image has the tag: the images workflow
// publishes sha-<commit> only after Trivy passed.
async function published(image, tag) {
  const repository = `${OWNER}/hookline-${image}`;
  const { token } = await getJson(
    `https://${REGISTRY}/token?scope=repository:${repository}:pull`,
  );
  const response = await fetch(
    `https://${REGISTRY}/v2/${repository}/manifests/${tag}`,
    {
      method: 'HEAD',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.oci.image.index.v1+json',
      },
    },
  );
  return response.ok;
}

// Moves the local overlay to the images of the latest commit on main. The
// change goes through a pull request like any other, and Argo CD rolls it
// out once it is merged; reverting that commit rolls it back.
async function bump() {
  run('git', ['fetch', '--quiet', 'origin', 'main']);
  const sha = run('git', ['rev-parse', 'origin/main'], { quiet: true }).trim();
  const tag = `sha-${sha}`;
  for (const image of IMAGES) {
    if (!(await published(image, tag))) {
      throw new Error(
        `hookline-${image}:${tag} is not on GHCR yet: wait for the Images workflow on main.`,
      );
    }
  }
  const before = readFileSync(OVERLAY, 'utf8');
  const after = before.replace(/newTag: sha-[0-9a-f]{40}/g, `newTag: ${tag}`);
  if (after === before) {
    console.log(`Already on ${tag}`);
    return;
  }
  writeFileSync(OVERLAY, after);
  console.log(
    `Pinned the local overlay to ${tag}. Commit it in a pull request.`,
  );
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
  case 'argocd':
    argocd();
    break;
  case 'bump':
    await bump();
    break;
  case 'backup':
    await backup();
    break;
  case 'restore-test':
    await restoreTest();
    break;
  case 'restore':
    await restore(args[0]);
    break;
  default:
    console.error(
      'Usage: node scripts/k8s.mjs up [overlay] | down | images | project NAME | obs | obs-check | argocd | bump | backup | restore-test | restore [BACKUP]',
    );
    process.exit(1);
}
