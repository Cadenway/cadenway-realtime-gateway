import type { FactoryProvider } from '@nestjs/common';

import { CheckConnection } from '../../../../application/use-cases/queries/connection/check-connection/check-connection.use-case.js';

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
  useFactory: (): CheckConnection => new CheckConnection(),
};
