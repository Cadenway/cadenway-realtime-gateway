import { EventConsumers, MessagingConnection } from '@cadenway/nest-messaging';
import { Module } from '@nestjs/common';

import { RelayBrokerReadiness } from '../../infrastructure/nats/relay-broker-readiness.js';
import { RealtimeAdmissionGates } from '../../infrastructure/redis/realtime-admission-gates.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { ConnectionRecipients } from '../connection/public/connection/connection-recipients.js';
import { ApplyRelayInvalidation } from './application/use-cases/commands/relay/apply-relay-invalidation/apply-relay-invalidation.use-case.js';
import { RelayTaskChange } from './application/use-cases/commands/relay/relay-task-change/relay-task-change.use-case.js';
import { RelayConnectionsAdapter } from './infrastructure/adapters/connection/relay/relay-connections.adapter.js';
import {
  RelayEventsHandler,
  relayInvalidationHandlers,
} from './presentation/messaging/handlers/relay/relay-events.handler.js';

/** Wires validated broker facts to current authorization and targeted socket delivery. */
@Module({
  imports: [RedisModule],
  providers: [
    {
      provide: RelayConnectionsAdapter,
      inject: [ConnectionRecipients],
      useFactory: (connections: ConnectionRecipients): RelayConnectionsAdapter =>
        new RelayConnectionsAdapter(connections),
    },
    {
      provide: RelayTaskChange,
      inject: [RelayConnectionsAdapter],
      useFactory: (connections: RelayConnectionsAdapter): RelayTaskChange =>
        new RelayTaskChange(connections),
    },
    {
      provide: ApplyRelayInvalidation,
      inject: [RelayConnectionsAdapter],
      useFactory: (connections: RelayConnectionsAdapter): ApplyRelayInvalidation =>
        new ApplyRelayInvalidation(connections),
    },
    {
      provide: RelayEventsHandler,
      inject: [EventConsumers, ApplyRelayInvalidation, RelayTaskChange],
      useFactory: (
        consumers: EventConsumers,
        invalidation: ApplyRelayInvalidation,
        changes: RelayTaskChange,
      ): RelayEventsHandler => new RelayEventsHandler(consumers, invalidation, changes),
    },
    {
      provide: RelayBrokerReadiness,
      inject: [MessagingConnection, EventConsumers, RealtimeAdmissionGates],
      useFactory: (
        connection: MessagingConnection,
        consumers: EventConsumers,
        admission: RealtimeAdmissionGates,
      ): RelayBrokerReadiness => {
        const handlerNames = Object.values(relayInvalidationHandlers);
        const readiness = new RelayBrokerReadiness(
          (listener) => connection.watchAvailability(listener),
          (signal) => consumers.areCaughtUp(handlerNames, signal),
        );
        admission.track(
          'broker-relays',
          () => readiness.ready,
          (listener) => readiness.onUnavailable(listener),
        );
        return readiness;
      },
    },
  ],
})
export class RelaysModule {}
