import type { RealtimeRoom } from './realtime-room.model.js';

/** Joining succeeds with the previous room, reaches capacity, or loses the visibility fence. */
export type SocketRegistryJoin =
  | { readonly kind: 'joined'; readonly previousRoom: RealtimeRoom | null }
  | { readonly kind: 'room-limit' }
  | null;
