import { ConfigModule, HealthModule, type HealthModuleOptions } from '@cadenway/nest-common';
import { Module } from '@nestjs/common';

import { appConfigSchema } from './config/app-config.js';
import { RealtimeGateway } from './connection/realtime.gateway.js';
import { RedisConnection } from './infrastructure/redis/redis-connection.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';

/**
 * Class AppModule
 *
 * @description
 * Root module of the realtime gateway, wrapped by `createApplication` of `@cadenway/nest-common`,
 * which adds the logs, the error format, the validation pipe, the interceptors, the body limit and
 * the request deadline.
 *
 * - `ConfigModule` validates the environment against `appConfigSchema` while this module is
 *   declared, so an invalid environment stops the process before anything is created, and
 *   provides it under `CONFIG`.
 * - `RedisModule` opens the main Redis connection, which the Socket.IO adapter duplicates.
 * - `HealthModule` serves `GET /health/live`, which checks nothing, and `GET /health/ready`, which
 *   answers 503 while Redis does not answer `PING` within one second. Both are what the container
 *   healthcheck and the deployment probe. The broker joins readiness with
 *   `@cadenway/nest-messaging`.
 * - `RealtimeGateway` is the Socket.IO entry point.
 *
 * The modules of `src/connection/`, `src/relays/` and `src/presence/` are registered here as they
 * are created.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ schema: appConfigSchema }),
    RedisModule,
    HealthModule.forRootAsync({
      inject: [RedisConnection],
      useFactory: (redis: RedisConnection): HealthModuleOptions => ({
        indicators: [redis.healthIndicator()],
      }),
    }),
  ],
  providers: [RealtimeGateway],
})
export class AppModule {}
