import { ResilientRedisClient } from '@cadenway/nest-common/redis';
import { Global, Module } from '@nestjs/common';

import { RealtimeClientsModule } from '../../clients/clients.module.js';
import { RealtimeTaskClient } from '../../clients/realtime-task.client.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { RealtimeAdmissionGates } from '../../infrastructure/redis/realtime-admission-gates.js';
import { ChangeRoom } from './application/use-cases/commands/connection/change-room/change-room.use-case.js';
import { ConnectionRecipients } from './application/use-cases/commands/connection/connection-recipients/connection-recipients.use-case.js';
import { checkConnectionProvider } from './composition/providers/use-cases/connection/check-connection.provider.js';
import { trackSocketPresenceProvider } from './composition/providers/use-cases/connection/track-socket-presence.provider.js';
import { RedisSocketRegistry } from './infrastructure/adapters/redis/connection/redis-socket-registry.adapter.js';
import { RedisRelayInbox } from './infrastructure/adapters/redis/connection/redis-relay-inbox.adapter.js';
import { SocketIoRecipients } from './infrastructure/adapters/socket-io/connection/socket-io-recipients.adapter.js';
import { RealtimeGateway } from './presentation/websocket/gateways/realtime/realtime.gateway.js';

/**
 * Class ConnectionModule
 *
 * @description
 * Connects the Socket.IO entry point to the application decision for incoming connections.
 */
@Global()
@Module({
  imports: [RedisModule, RealtimeClientsModule],
  providers: [
    {
      provide: RedisSocketRegistry,
      inject: [ResilientRedisClient],
      useFactory: (redis: ResilientRedisClient): RedisSocketRegistry =>
        new RedisSocketRegistry(redis),
    },
    checkConnectionProvider,
    trackSocketPresenceProvider,
    {
      provide: ChangeRoom,
      inject: [RealtimeTaskClient, RedisSocketRegistry],
      useFactory: (task: RealtimeTaskClient, registry: RedisSocketRegistry): ChangeRoom =>
        new ChangeRoom(task, registry),
    },
    RealtimeGateway,
    {
      provide: SocketIoRecipients,
      inject: [RealtimeGateway, RedisSocketRegistry, RealtimeAdmissionGates],
      useFactory: (
        gateway: RealtimeGateway,
        registry: RedisSocketRegistry,
        gates: RealtimeAdmissionGates,
      ): SocketIoRecipients =>
        new SocketIoRecipients(
          () => gateway.server,
          registry,
          () => gates.ready,
        ),
    },
    {
      provide: RedisRelayInbox,
      inject: [
        ResilientRedisClient,
        RedisSocketRegistry,
        SocketIoRecipients,
        RealtimeAdmissionGates,
      ],
      useFactory: (
        redis: ResilientRedisClient,
        registry: RedisSocketRegistry,
        transport: SocketIoRecipients,
        gates: RealtimeAdmissionGates,
      ): RedisRelayInbox =>
        new RedisRelayInbox(
          redis,
          registry.deliveryChannel,
          (payload) => transport.receive(payload),
          gates,
        ),
    },
    {
      provide: ConnectionRecipients,
      inject: [SocketIoRecipients, RedisSocketRegistry, RealtimeTaskClient],
      useFactory: (
        transport: SocketIoRecipients,
        registry: RedisSocketRegistry,
        task: RealtimeTaskClient,
      ): ConnectionRecipients => new ConnectionRecipients(registry, transport, task),
    },
  ],
  exports: [ConnectionRecipients],
})
export class ConnectionModule {}
