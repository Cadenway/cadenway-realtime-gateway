import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { Socket } from 'socket.io';

import { CheckConnection } from '../../../../application/use-cases/queries/connection/check-connection/check-connection.use-case.js';

/**
 * Class RealtimeGateway
 *
 * @description
 * Socket.IO entry point of the gateway.
 *
 * Applies the connection decision made by the application to the Socket.IO socket.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection<Socket> {
  // #region Properties
  /**
   * Property checkConnection
   *
   * @description
   * Decides whether an incoming connection can stay open.
   *
   * @type {CheckConnection}
   * @readonly
   */
  private readonly checkConnection: CheckConnection;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Connects the Socket.IO gateway to its application use case.
   *
   * @param {CheckConnection} checkConnection - Application query for incoming connections.
   * @constructor
   */
  public constructor(checkConnection: CheckConnection) {
    this.checkConnection = checkConnection;
  }
  // #endregion

  // #region Methods
  /**
   * Method handleConnection
   *
   * @description
   * Disconnects a socket when the application rejects the connection.
   *
   * @param {Socket} client - Newly connected client socket.
   */
  public handleConnection(client: Socket): void {
    if (!this.checkConnection.execute()) {
      client.disconnect(true);
    }
  }
  // #endregion
}
