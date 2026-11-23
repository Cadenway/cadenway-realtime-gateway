import { ResilientRedisClient } from '@cadenway/nest-common/redis';
import { Module } from '@nestjs/common';

import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { ManagePresence } from './application/use-cases/commands/presence/manage-presence/manage-presence.use-case.js';
import { RedisPresenceStore } from './infrastructure/adapters/redis/presence/redis-presence-store.adapter.js';
import { ExpirePresenceHandler } from './presentation/jobs/handlers/presence/expire-presence.handler.js';

/** Shares one presence authority with the connection capability. */
@Module({
  imports: [RedisModule],
  providers: [
    {
      provide: ManagePresence,
      inject: [ResilientRedisClient],
      useFactory: (redis: ResilientRedisClient): ManagePresence =>
        new ManagePresence(new RedisPresenceStore(redis)),
    },
    {
      provide: ExpirePresenceHandler,
      inject: [ManagePresence],
      useFactory: (presence: ManagePresence): ExpirePresenceHandler =>
        new ExpirePresenceHandler(presence),
    },
  ],
  exports: [ManagePresence],
})
export class PresenceModule {}
