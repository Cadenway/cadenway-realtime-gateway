import { Global, Module } from '@nestjs/common';

import { RedisConnection } from './redis-connection.js';

/**
 * Class RedisModule
 *
 * @description
 * Owns the main Redis connection of the realtime gateway. The fan-out between instances goes
 * through the Socket.IO adapter, which `realtime-application.ts` builds from this connection;
 * presence will use it from `src/presence/`.
 *
 * Global, because `HealthModule.forRootAsync` builds the readiness indicator from
 * `RedisConnection` and only resolves providers that are visible globally.
 */
@Global()
@Module({ providers: [RedisConnection], exports: [RedisConnection] })
export class RedisModule {}
