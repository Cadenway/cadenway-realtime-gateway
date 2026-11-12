import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { Socket } from 'socket.io';

/**
 * Socket.IO entry point of the gateway.
 *
 * Bootstrap shell: handshake authentication does not exist yet, and an unauthenticated socket is
 * closed immediately, so every socket is closed as soon as it connects. Authentication and rooms
 * (`org:<id>`, `list:<id>`, `task:<id>`), relays and presence are added by their own modules.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection<Socket> {
  /** Closes the socket: no client can be authenticated yet. */
  handleConnection(client: Socket): void {
    client.disconnect(true);
  }
}
