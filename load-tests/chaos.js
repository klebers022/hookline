// The chaos test's traffic: EVENTS events at RATE per second, while
// scripts/chaos.mjs takes the cluster apart. Every hundredth event is of the
// rare type, the only one the endpoint that never answers is subscribed to.
// Run with pnpm chaos, which counts the events accepted here against the
// rows in the database.
//
// It behaves like a careful client: a request that fails is sent again
// with the same Idempotency-Key, so an event the API saved but could not
// confirm (the database died after the commit) is not saved twice.
import { sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const API = __ENV.API_URL || 'http://api:3000';
const RATE = Number(__ENV.RATE || 50);
const EVENTS = Number(__ENV.EVENTS || 10000);
const TRIES = 60;

const accepted = new Counter('events_accepted');
const retries = new Counter('events_retried');
const gaveUp = new Counter('events_given_up');

export const options = {
  scenarios: {
    chaos: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${Math.ceil(EVENTS / RATE)}s`,
      preAllocatedVUs: 200,
      maxVUs: 2000,
    },
  },
};

export default function () {
  const n = exec.scenario.iterationInTest;
  const body = JSON.stringify({
    type: n % 100 === 99 ? 'chaos.rare' : 'chaos.event',
    payload: { n },
  });
  const params = {
    headers: {
      authorization: `Bearer ${__ENV.API_KEY}`,
      'content-type': 'application/json',
      'idempotency-key': `${__ENV.RUN_ID}-${n}`,
    },
    // A request that hangs while the database restarts is given up on and
    // sent again.
    timeout: '10s',
    tags: { name: 'POST /v1/events' },
  };
  for (let tryNumber = 1; tryNumber <= TRIES; tryNumber += 1) {
    const response = http.post(`${API}/v1/events`, body, params);
    if (response.status === 202) {
      accepted.add(1);
      return;
    }
    retries.add(1, { status: String(response.status) });
    sleep(1);
  }
  gaveUp.add(1);
}

// The counts go to a file, for scripts/chaos.mjs to print and check.
export function handleSummary(data) {
  const count = (name) => data.metrics[name]?.values.count ?? 0;
  return {
    '/out/summary.json': JSON.stringify({
      accepted: count('events_accepted'),
      retries: count('events_retried'),
      gave_up: count('events_given_up'),
      dropped: count('dropped_iterations'),
    }),
  };
}
