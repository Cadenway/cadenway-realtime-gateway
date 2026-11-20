import { createApplication, type CreateApplicationOptions } from '@cadenway/nest-common';
import { ResilientRedisClient } from '@cadenway/nest-common/redis';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import { AppModule } from './app.module.js';
import { RealtimeAdmissionGates } from './infrastructure/redis/realtime-admission-gates.js';
import type { AppConfig } from './config/app-config.js';
import { RedisIoAdapter, SocketIoRedisReadiness } from './infrastructure/redis/redis-io.adapter.js';

/**
 * Constant SERVICE_NAME
 *
 * @description
 * Name of the realtime gateway in its logs and traces.
 *
 * @type {string}
 */
export const SERVICE_NAME: string = 'realtime-gateway';

/**
 * Constant TRUSTED_PROXY_HOPS
 *
 * @description
 * Number of proxies in front of the gateway whose `X-Forwarded-*` headers Express trusts: Traefik,
 * and only Traefik. A header the client wrote itself is never believed.
 *
 * @type {number}
 */
export const TRUSTED_PROXY_HOPS: number = 1;

/**
 * Constant CORS_ALLOWED_METHODS
 *
 * @description
 * Methods a browser may use on the HTTP routes of the gateway from an allowed origin: they only
 * read. The Socket.IO long-polling transport answers its own CORS (see `RedisIoAdapter`).
 *
 * @type {readonly string[]}
 */
export const CORS_ALLOWED_METHODS: readonly string[] = ['GET', 'HEAD'];

/**
 * Constant CORS_MAX_AGE_SECONDS
 *
 * @description
 * How long a browser may reuse a preflight answer of an HTTP route, in seconds.
 *
 * @type {number}
 */
export const CORS_MAX_AGE_SECONDS: number = 600;

/**
 * Function createRealtimeApplication
 *
 * @description
 * Creates the realtime gateway with the shared formats of `@cadenway/nest-common`, the settings
 * of a public edge and the Socket.IO adapter, ready to listen. `main.ts` calls it with the
 * configuration of the process; the integration tests call it with theirs, so both run the same
 * start-up. It waits while the NATS broker is unreachable, and rejects when the application cannot
 * be created, such as for an environment `ConfigModule` refuses or a broker without the `EVENTS`
 * stream.
 *
 * - The internal token is signed for the calls the gateway will make to cadenway-identity-service
 *   and cadenway-task-service (`INTERNAL_TOKEN_ISSUER`, `INTERNAL_TOKEN_PRIVATE_JWK`) and verified
 *   on none: the gateway authenticates the sockets itself.
 * - An incoming `X-Request-Id` or `X-Request-Timeout-Ms` is ignored: a client chooses neither the
 *   reference of its request nor the budget of the internal calls.
 * - Express trusts one proxy hop, Traefik, and `helmet` sets its default security headers on the
 *   HTTP routes. No cookie is read: the handshake credential is the ticket in `auth.token`.
 * - CORS of the HTTP routes answers the origins of `ALLOWED_ORIGINS` only, by exact comparison and
 *   with credentials; a preflight from any other origin gets no `Access-Control-Allow-Origin`.
 * - `RedisIoAdapter` carries the Socket.IO server: the exact `Origin` check of the handshake, the
 *   CORS of long-polling and the fan-out through Redis. It is registered before the application
 *   initializes, which is when NestJS binds the gateways.
 *
 * @param {Readonly<AppConfig>} config - Validated configuration of the gateway.
 * @param {CreateApplicationOptions['logDestination']} logDestination - Stream of the log lines;
 * the standard output when omitted. For tests.
 * @returns {Promise<NestExpressApplication>} The application, not yet listening.
 */
export async function createRealtimeApplication(
  config: Readonly<AppConfig>,
  logDestination?: CreateApplicationOptions['logDestination'],
): Promise<NestExpressApplication> {
  const app: NestExpressApplication = await createApplication(AppModule, {
    service: SERVICE_NAME,
    config,
    internalToken: {
      signer: {
        issuer: config.INTERNAL_TOKEN_ISSUER,
        privateJwk: config.INTERNAL_TOKEN_PRIVATE_JWK,
      },
    },
    internalTokenVerification: 'off',
    acceptIncomingRequestId: false,
    acceptIncomingRequestTimeout: false,
    logDestination,
  });
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
  app.use(helmet());
  app.enableCors({
    origin: [...config.ALLOWED_ORIGINS],
    credentials: true,
    methods: [...CORS_ALLOWED_METHODS],
    maxAge: CORS_MAX_AGE_SECONDS,
  });
  app.useWebSocketAdapter(
    new RedisIoAdapter(
      app,
      app.get(ResilientRedisClient),
      config.ALLOWED_ORIGINS,
      app.get(SocketIoRedisReadiness),
      app.get(RealtimeAdmissionGates),
    ),
  );
  return app;
}
