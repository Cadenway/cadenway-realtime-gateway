import {
  CONFIG,
  ConfigModule,
  HealthModule,
  redisIndicator,
  type HealthModuleOptions,
} from '@cadenway/nest-common';
import { ResilientRedisClient } from '@cadenway/nest-common/redis';
import {
  MessagingConnection,
  messagingHealthIndicator,
  MessagingModule,
  type MessagingModuleOptions,
} from '@cadenway/nest-messaging';
import { Module } from '@nestjs/common';

import { appConfigSchema, type AppConfig } from './config/app-config.js';
import { SocketIoRedisReadiness } from './infrastructure/redis/redis-io.adapter.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { ConnectionModule } from './modules/connection/connection.module.js';
import { PresenceModule } from './modules/presence/presence.module.js';
import { RelaysModule } from './modules/relays/relays.module.js';
import { RealtimeAdmissionGates } from './infrastructure/redis/realtime-admission-gates.js';

/**
 * Constant MESSAGING_SERVICE_NAME
 *
 * @description
 * Name of the gateway for `@cadenway/nest-messaging`: the name of its NATS connection and the
 * prefix of its durable consumers (`realtime-gateway__<handler>`). Renaming it renames every
 * consumer, which then starts from scratch.
 *
 * @type {string}
 */
export const MESSAGING_SERVICE_NAME: string = 'realtime-gateway';

/**
 * Constant SHUTDOWN_DELAY_MS
 *
 * @description
 * How long the stop keeps serving with readiness at 503 before it closes the listener and the
 * sockets, in milliseconds.
 *
 * Traefik routes to the containers Docker reports healthy and learns about them through Docker
 * events, applied at most every 2 seconds (its default provider throttle, which cadenway-ops does
 * not change). During a rolling update the GitOps agent stops the old container as soon as the new
 * one is healthy (it polls every 2 seconds): for up to 2 seconds more Traefik may still route only
 * to the old one. Three seconds keep it answering through that window. Readiness itself does not
 * take the instance out of Traefik: the container healthcheck needs five failed probes ten seconds
 * apart, longer than the 30 seconds the agent gives a stop; Traefik drops the instance when it
 * exits. The delay plus the drain of the NATS connection (immediate while NATS answers) stay under
 * the 10 second default grace period of Docker.
 *
 * @type {number}
 */
export const SHUTDOWN_DELAY_MS: number = 3000;

/**
 * Function messagingOptions
 *
 * @description
 * Options of the NATS connection of the gateway, from its validated configuration. The gateway
 * connects as the NATS user `realtime-gateway` of cadenway-ops, whose inbox prefix
 * (`_INBOX.realtime-gateway`) the kit derives from the user. It relays events and publishes none,
 * so it has no outbox (no database) and never imports `@cadenway/nest-messaging/outbox`.
 *
 * - `manageStreams: false`: cadenway-ops creates the streams and the user may not; the start-up
 *   checks that `EVENTS` exists and fails clearly otherwise.
 * - `deadLetterWorker: false`: notification-service alone copies dead letters.
 *
 * @param {AppConfig} config - Validated configuration of the gateway.
 * @returns {MessagingModuleOptions} The options of `MessagingModule`.
 */
export function messagingOptions(config: AppConfig): MessagingModuleOptions {
  return {
    service: MESSAGING_SERVICE_NAME,
    servers: config.NATS_URL,
    user: config.NATS_USER,
    password: config.NATS_PASSWORD,
    manageStreams: false,
    deadLetterWorker: false,
  };
}

/**
 * Class AppModule
 *
 * @description
 * Root module of the realtime gateway, wrapped by `createApplication` of `@cadenway/nest-common`,
 * which adds the logs, the error format, the validation pipe, the interceptors, the body limit and
 * the request deadline.
 *
 * - `ConfigModule` validates the environment against `appConfigSchema` when the application is
 *   created (`eager: false`), so importing this module reads nothing and an invalid environment
 *   rejects `createApplication` with the `ConfigError` that `runApplication` writes as one line.
 *   It provides the configuration under `CONFIG`.
 * - `RedisModule` opens the main Redis connection, from which the Socket.IO adapter derives its
 *   own two.
 * - `MessagingModule` opens the NATS connection while the application is created, waiting for the
 *   broker if it is not there yet, then reconnects forever. `RelaysModule` registers the durable
 *   subscriptions defined in `@cadenway/contracts`.
 * - `HealthModule` serves `GET /health/live`, which checks nothing, and `GET /health/ready`, which
 *   answers 503 until Redis answers `PING` and confirms the Socket.IO subscriptions, while NATS
 *   does not answer a flush within one second, and from the start of the stop (see
 *   `SHUTDOWN_DELAY_MS`). Both are what the container healthcheck and the deployment probe.
 * - `ConnectionModule` registers the Socket.IO entry point.
 *
 * Realtime capability modules under `src/modules/` are registered here as they are created.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ schema: appConfigSchema, eager: false }),
    RedisModule,
    MessagingModule.forRootAsync({ inject: [CONFIG], useFactory: messagingOptions }),
    HealthModule.forRootAsync({
      imports: [RedisModule],
      inject: [
        ResilientRedisClient,
        SocketIoRedisReadiness,
        MessagingConnection,
        RealtimeAdmissionGates,
      ],
      useFactory: (
        redis: ResilientRedisClient,
        socketIoRedis: SocketIoRedisReadiness,
        nats: MessagingConnection,
        admission: RealtimeAdmissionGates,
      ): HealthModuleOptions => {
        const redisCheck = redisIndicator(redis);
        return {
          indicators: [
            {
              ...redisCheck,
              check: async () => {
                socketIoRedis.assertAvailable();
                await redisCheck.check();
                socketIoRedis.assertAvailable();
              },
            },
            messagingHealthIndicator(nats),
            {
              name: 'realtime-admission',
              check: () =>
                admission.ready
                  ? Promise.resolve()
                  : Promise.reject(new Error('The realtime subscriptions are not ready.')),
            },
          ],
          shutdownDelayMs: SHUTDOWN_DELAY_MS,
        };
      },
    }),
    PresenceModule,
    ConnectionModule,
    RelaysModule,
  ],
})
export class AppModule {}
