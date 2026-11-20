import { CONFIG } from '@cadenway/nest-common';
import { ResilientRedisClient } from '@cadenway/nest-common/redis';
import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { RealtimeAdmissionGates } from './realtime-admission-gates.js';
import { SocketIoRedisReadiness } from './redis-io.adapter.js';

/**
 * Constant CONNECTION_NAME
 *
 * @description
 * Name the main connection announces with `CLIENT SETNAME`, so `CLIENT LIST` on the shared Redis
 * of an environment tells the realtime gateway apart from the API gateway. The Socket.IO adapter
 * connections append `-publisher` and `-subscriber`.
 *
 * @type {string}
 */
export const CONNECTION_NAME: string = 'realtime-gateway';

/**
 * Class RedisModule
 *
 * @description
 * Owns the main Redis connection of the realtime gateway, provided under the `ResilientRedisClient`
 * class of `@cadenway/nest-common/redis`: readiness probes it with `PING`, the Socket.IO adapter
 * derives its publisher and subscriber from its options, and presence will use it from
 * `src/modules/presence/`.
 *
 * - The connection is opened at start-up from `REDIS_URL` without waiting for it: the application
 *   starts while Redis is still unreachable, and readiness answers 503 until it is ready.
 * - The offline queue is disabled: while Redis is unreachable a command fails at once instead of
 *   waiting for the reconnection. In-flight commands are not replayed after a loss. Readiness
 *   checks the command connection and the Socket.IO subscriptions. The client keeps reconnecting.
 * - The client logs an outage once (`redis unreachable`, with an error code at most, never the
 *   address) and its end once (`redis reachable again`); it attaches a handler to every command it
 *   sends, so a command nobody awaits cannot stop the process.
 * - It is closed when the application stops, after NestJS disposed of the Socket.IO adapter and
 *   its two connections.
 *
 * Imported by `AppModule` and by the `HealthModule` that builds the readiness indicator from it.
 */
@Module({
  providers: [
    {
      provide: ResilientRedisClient,
      inject: [CONFIG],
      useFactory: (config: AppConfig): ResilientRedisClient =>
        new ResilientRedisClient(config.REDIS_URL, {
          connectionName: CONNECTION_NAME,
          enableOfflineQueue: false,
          autoResendUnfulfilledCommands: false,
          maxRetriesPerRequest: 0,
        }),
    },
    SocketIoRedisReadiness,
    RealtimeAdmissionGates,
  ],
  exports: [ResilientRedisClient, SocketIoRedisReadiness, RealtimeAdmissionGates],
})
export class RedisModule implements OnApplicationShutdown {
  // #region Properties
  /**
   * Property client
   *
   * @description
   * Main Redis connection of the gateway, closed by `onApplicationShutdown`.
   *
   * @type {ResilientRedisClient}
   * @readonly
   */
  private readonly client: ResilientRedisClient;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Keeps the main connection to close it at shutdown.
   *
   * @param {ResilientRedisClient} client - Main Redis connection of the gateway.
   * @constructor
   */
  public constructor(@Inject(ResilientRedisClient) client: ResilientRedisClient) {
    this.client = client;
  }
  // #endregion

  // #region Methods
  /**
   * Method onApplicationShutdown
   *
   * @description
   * Closes the main connection once the listener and the Socket.IO servers are closed. A ready
   * connection is closed with `QUIT`, which lets the commands already sent complete; any other
   * state closes the socket at once and stops the reconnection attempts, without a log line.
   *
   * @returns {Promise<void>} Resolves once the connection is closed.
   */
  public async onApplicationShutdown(): Promise<void> {
    await this.client.shutDown();
  }
  // #endregion
}
