import { Module } from '@nestjs/common';

import { RealtimeGateway } from './connection/realtime.gateway.js';
import { HealthController } from './health/health.controller.js';

/**
 * Class AppModule
 *
 * @description
 * Root module of the gateway.
 *
 * The modules of `src/connection/`, `src/relays/` and `src/presence/` are registered here as they
 * are created. The health controller is a bootstrap placeholder until `@cadenway/nest-common`
 * provides the health module.
 */
@Module({ controllers: [HealthController], providers: [RealtimeGateway] })
export class AppModule {}
