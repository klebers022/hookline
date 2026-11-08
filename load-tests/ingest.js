// Ingestion capacity: the publish rate climbs until the API breaks its
// target (p99 under 200 ms, no errors) or the machine runs out. Each event
// fans out to one endpoint, so the whole pipeline works while the API is
// measured. Run with pnpm load:ingest.
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
    ingest: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: Number(__ENV.MAX_VUS || 1000),
      stages: [
        {
          target: Number(__ENV.MAX_RATE || 800),
          duration: __ENV.RAMP || '4m',
        },
      ],
    },
  },
  thresholds: {
    // The target, reported at the end. The run goes on past it, to find
    // where the API stops keeping up.
    'http_req_duration{expected_response:true}': ['p(99)<200'],
    // Stops the run once the API is clearly overwhelmed.
    http_req_failed: [
      { threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '20s' },
    ],
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
