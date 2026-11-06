import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  Counter,
  Histogram,
  nameServerSpan,
  Registry,
  type Pool,
  type ResolveHost,
} from '@hookline/shared';
import Fastify, { type FastifyError } from 'fastify';
import { STATUS_CODES } from 'node:http';
import { createAuthHook } from './auth.js';
import { ProblemError } from './errors.js';
import { deliveryRoutes } from './routes/deliveries.js';
import { endpointRoutes } from './routes/endpoints.js';
import { eventRoutes } from './routes/events.js';

const BODY_LIMIT_BYTES = 256 * 1024;

export interface AppOptions {
  pool: Pool;
  encryptionKey: Buffer;
  logger?: boolean;
  rateLimitPerMinute?: number;
  allowPrivateTargets?: boolean;
  resolveHost?: ResolveHost;
  registry?: Registry;
}

export type ApiMetrics = ReturnType<typeof createApiMetrics>;

function createApiMetrics(registry: Registry) {
  const registers = [registry];
  return {
    // The route is the pattern, such as /v1/events/:id, so ids never become
    // labels.
    requestDuration: new Histogram({
      name: 'hookline_http_request_duration_seconds',
      help: 'API request duration, by method, route and status class.',
      labelNames: ['method', 'route', 'status_class'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2.5],
      registers,
    }),
    eventsAccepted: new Counter({
      name: 'hookline_events_accepted_total',
      help: 'Events accepted, without Idempotency-Key replays.',
      registers,
    }),
    deliveriesCreated: new Counter({
      name: 'hookline_deliveries_created_total',
      help: 'Deliveries created by fan-out to subscribed endpoints.',
      registers,
    }),
  };
}

export async function buildApp({
  pool,
  encryptionKey,
  logger = false,
  rateLimitPerMinute = 6_000,
  allowPrivateTargets = false,
  resolveHost,
  registry = new Registry(),
}: AppOptions) {
  const metrics = createApiMetrics(registry);
  const app = Fastify({
    logger,
    bodyLimit: BODY_LIMIT_BYTES,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Some clients send a Content-Type on a POST without a body, such as a
  // retry. An empty body is accepted whatever its type, and any other body
  // still has to be valid JSON.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      if (body === '') {
        done(null, undefined);
        return;
      }
      // parseAs: 'string' always hands over a string.
      parseJson(request, body as string, done);
    },
  );
  app.addContentTypeParser(
    '*',
    { parseAs: 'string' },
    (request, body, done) => {
      if (body === '') {
        done(null, undefined);
        return;
      }
      const error = new Error(
        `Unsupported Media Type: ${request.headers['content-type']}`,
      );
      done(Object.assign(error, { statusCode: 415 }), undefined);
    },
  );

  await app.register(swagger, {
    openapi: {
      info: { title: 'Hookline API', version: '0.1.0' },
      components: {
        securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } },
      },
      security: [{ apiKey: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      error instanceof ProblemError ? error.status : (error.statusCode ?? 500);
    if (status >= 500) {
      request.log.error(error);
    }
    const title =
      error instanceof ProblemError
        ? error.title
        : (STATUS_CODES[status] ?? 'Error');
    return reply
      .code(status)
      .type('application/problem+json')
      .send({
        type: 'about:blank',
        title,
        status,
        ...(status < 500 && { detail: error.message }),
      });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).type('application/problem+json').send({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
    }),
  );

  // Fastify knows the route, which the HTTP span from the instrumentation
  // does not.
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.url) {
      nameServerSpan(request.method, request.routeOptions.url);
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    metrics.requestDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status_class: `${Math.floor(reply.statusCode / 100)}xx`,
      },
      reply.elapsedTime / 1000,
    );
  });

  app.get('/healthz', { schema: { hide: true } }, async () => ({
    status: 'ok',
  }));

  app.get('/readyz', { schema: { hide: true } }, async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch (error) {
      request.log.error(error);
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  await app.register(
    async (v1) => {
      v1.decorateRequest('projectId', '');
      v1.addHook('onRequest', createAuthHook(pool));
      // Runs after authentication, so each project has its own limit and
      // requests without a valid key never reach it.
      await v1.register(rateLimit, {
        max: rateLimitPerMinute,
        timeWindow: 60_000,
        keyGenerator: (request) => request.projectId,
        errorResponseBuilder: (_request, { after }) =>
          new ProblemError(
            429,
            'Too Many Requests',
            `Rate limit exceeded, retry in ${after}`,
          ),
      });
      await v1.register(endpointRoutes, {
        pool,
        encryptionKey,
        targetPolicy: { allowPrivateTargets },
        ...(resolveHost && { resolveHost }),
      });
      await v1.register(eventRoutes, { pool, metrics });
      await v1.register(deliveryRoutes, { pool });
    },
    { prefix: '/v1' },
  );

  return app;
}
