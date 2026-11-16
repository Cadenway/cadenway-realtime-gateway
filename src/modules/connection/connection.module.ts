import { Module } from '@nestjs/common';

import { checkConnectionProvider } from './composition/providers/use-cases/connection/check-connection.provider.js';
import { RealtimeGateway } from './presentation/websocket/gateways/realtime/realtime.gateway.js';

/**
 * Class ConnectionModule
 *
 * @description
 * Connects the Socket.IO entry point to the application decision for incoming connections.
 */
@Module({ providers: [checkConnectionProvider, RealtimeGateway] })
export class ConnectionModule {}
