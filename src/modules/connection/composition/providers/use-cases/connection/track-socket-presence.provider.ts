import type { FactoryProvider } from '@nestjs/common';

import {
  ManagePresence,
  type PresenceConnection,
} from '../../../../../presence/public/presence/manage-presence.js';
import { TrackSocketPresence } from '../../../../application/use-cases/commands/connection/track-socket-presence/track-socket-presence.use-case.js';
import type { RealtimeSession } from '../../../../application/models/connection/realtime-session.model.js';

function lease(socketId: string, session: RealtimeSession): PresenceConnection {
  return {
    socketId,
    organizationId: session.organizationId,
    memberId: session.memberId,
    sessionExpiresAt: session.expiresAt,
  };
}

/** Keeps the Presence capability at the Connection composition boundary. */
export const trackSocketPresenceProvider: FactoryProvider<TrackSocketPresence> = {
  provide: TrackSocketPresence,
  inject: [ManagePresence],
  useFactory: (presence: ManagePresence): TrackSocketPresence =>
    new TrackSocketPresence({
      connect: (socketId, session) => presence.execute(lease(socketId, session)),
      heartbeat: (socketId, session) => presence.heartbeat(lease(socketId, session)),
      set: (socketId, session, status) => presence.set(lease(socketId, session), status),
      disconnect: (socketId, session) => presence.disconnect(lease(socketId, session)),
    }),
};
