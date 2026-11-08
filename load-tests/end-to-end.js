// Steady load from publish to delivery: a fixed rate of events, each
// delivered to one endpoint, for a fixed time. scripts/load.mjs then waits
// for every delivery to finish and reads the first-attempt delay from
// Prometheus. Run with pnpm load:e2e.
import { check } from 'k6';
import http from 'k6/http';

const API = __ENV.API_URL || 'http://api:3000';
const params = {
  headers: {
    authorization: `Bearer ${__ENV.API_KEY}`,
    'content-type': 'application/json',
  },
  tags: { name: 'POST /v1/events' },
};

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 200),
      timeUnit: '1s',
      duration: __ENV.DURATION || '10m',
      preAllocatedVUs: 50,
      maxVUs: 500,
    },
  },
  thresholds: {
    'http_req_duration{expected_response:true}': ['p(99)<200'],
    http_req_failed: ['rate<0.001'],
    // Iterations k6 could not start in time: the rate was not held.
    dropped_iterations: ['count==0'],
  },
};

export default function () {
  const response = http.post(
    `${API}/v1/events`,
    JSON.stringify({
      type: 'load.test',
      payload: { iteration: __ITER, sent_at: Date.now() },
    }),
    params,
  );
  check(response, { accepted: (r) => r.status === 202 });
}
