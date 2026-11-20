import { CONFIG, InternalHttpClient, InternalTokenSigner } from '@cadenway/nest-common';
import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.js';
import { RealtimeIdentityClient } from './realtime-identity.client.js';
import { RealtimeTaskClient } from './realtime-task.client.js';

/** Shares the signed transport and its circuit breaker for each Realtime dependency. */
@Module({
  providers: [
    {
      provide: RealtimeIdentityClient,
      inject: [CONFIG, InternalTokenSigner],
      useFactory: (config: AppConfig, signer: InternalTokenSigner): RealtimeIdentityClient =>
        new RealtimeIdentityClient(
          new InternalHttpClient({
            service: 'identity-service',
            baseUrl: config.IDENTITY_SERVICE_URL,
            signer,
          }),
        ),
    },
    {
      provide: RealtimeTaskClient,
      inject: [CONFIG, InternalTokenSigner],
      useFactory: (config: AppConfig, signer: InternalTokenSigner): RealtimeTaskClient =>
        new RealtimeTaskClient(
          new InternalHttpClient({
            service: 'task-service',
            baseUrl: config.TASK_SERVICE_URL,
            signer,
          }),
        ),
    },
  ],
  exports: [RealtimeIdentityClient, RealtimeTaskClient],
})
export class RealtimeClientsModule {}
