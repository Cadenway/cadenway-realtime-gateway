import { ResilientRedisClient } from '@cadenway/nest-common/redis';
import { Global, Module } from '@nestjs/common';

import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { RealtimeAdmissionGates } from '../../infrastructure/redis/realtime-admission-gates.js';
import { ConnectionRecipients } from '../connection/public/connection/connection-recipients.js';
import { ManagePresence } from './application/use-cases/commands/presence/manage-presence/manage-presence.use-case.js';
import { RedisPresenceStore } from './infrastructure/adapters/redis/presence/redis-presence-store.adapter.js';
import { RedisPresenceSubscription } from './infrastructure/adapters/redis/presence/redis-presence-subscription.adapter.js';
import { ExpirePresenceHandler } from './presentation/jobs/handlers/presence/expire-presence.handler.js';

/** Shares one presence authority with the connection capability. */
@Global()
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
    {
      provide: RedisPresenceSubscription,
      inject: [ResilientRedisClient, ConnectionRecipients, RealtimeAdmissionGates],
      useFactory: (
        redis: ResilientRedisClient,
        connections: ConnectionRecipients,
        gates: RealtimeAdmissionGates,
      ): RedisPresenceSubscription =>
        new RedisPresenceSubscription(
          redis,
          (organizationId, packet) => connections.deliverPresence(organizationId, packet),
          (check, onUnavailable) => gates.track('presence', check, onUnavailable),
        ),
    },
  ],
  exports: [ManagePresence],
})
export class PresenceModule {}
