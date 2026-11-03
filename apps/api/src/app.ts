import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Pool, ResolveHost } from '@hookline/shared';
import Fastify, { type FastifyError } from 'fastify';
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
}

export async function buildApp({
  pool,
  encryptionKey,
  logger = false,
  rateLimitPerMinute = 6_000,
  allowPrivateTargets = false,
  resolveHost,
}: AppOptions) {
  const app = Fastify({
    logger,
    bodyLimit: BODY_LIMIT_BYTES,
  }).withTypeProvider<TypeBoxTypeProvider>();

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
        : status >= 500
          ? 'Internal Server Error'
          : 'Bad Request';
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
      await v1.register(eventRoutes, { pool });
      await v1.register(deliveryRoutes, { pool });
    },
    { prefix: '/v1' },
  );

  return app;
}
