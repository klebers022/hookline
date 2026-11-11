// The local Kubernetes cluster (k3d), in a few commands:
//   up [overlay]  creates the cluster if needed, the secrets, and applies the
//                 overlay (local by default; ci in the CI job)
//   down          deletes the cluster and everything in it
//   images        builds the four images as hookline-*:ci and imports them
//                 into the cluster, creating it if needed
//   project NAME  creates a project and prints its API key
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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

function up(overlay = 'local') {
  ensureCluster();
  run('kubectl', ['apply', '--filename', 'infra/k8s/base/namespace.yaml']);
  ensureSecrets();
  // A Job's pod template cannot change, so the migration starts over.
  kubectl('delete', 'job', 'migrate', '--ignore-not-found');
  run('kubectl', ['apply', '--kustomize', `infra/k8s/overlays/${overlay}`]);
  kubectl('wait', 'job/migrate', '--for=condition=complete', '--timeout=300s');
  const workloads = run(
    'kubectl',
    [
      '--namespace',
      NAMESPACE,
      'get',
      'statefulset,deployment',
      '--output',
      'name',
    ],
    { quiet: true },
  );
  for (const workload of workloads.split(/\s+/).filter(Boolean)) {
    kubectl('rollout', 'status', workload, '--timeout=300s');
  }
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
  default:
    console.error(
      'Usage: node scripts/k8s.mjs up [overlay] | down | images | project NAME',
    );
    process.exit(1);
}
