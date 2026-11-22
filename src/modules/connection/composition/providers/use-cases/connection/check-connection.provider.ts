import type { FactoryProvider } from '@nestjs/common';

import { RealtimeIdentityClient } from '../../../../../../clients/realtime-identity.client.js';
import { RealtimeOrganizationClient } from '../../../../../../clients/realtime-organization.client.js';
import { CheckConnection } from '../../../../application/use-cases/commands/connection/check-connection/check-connection.use-case.js';
import { RedisSocketRegistry } from '../../../../infrastructure/adapters/redis/connection/redis-socket-registry.adapter.js';

/**
 * Constant checkConnectionProvider
 *
 * @description
 * Instantiates the application query used by the connection gateway.
 *
 * @type {FactoryProvider<CheckConnection>}
 */
export const checkConnectionProvider: FactoryProvider<CheckConnection> = {
  provide: CheckConnection,
  inject: [RealtimeIdentityClient, RedisSocketRegistry, RealtimeOrganizationClient],
  useFactory: (
    identity: RealtimeIdentityClient,
    registry: RedisSocketRegistry,
    membership: RealtimeOrganizationClient,
  ): CheckConnection => new CheckConnection(identity, registry, membership),
};
