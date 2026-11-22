import type { RealtimeRoom } from '../../../../models/connection/realtime-room.model.js';

/** A verified membership change, generic refusal, or socket invalidation. */
export type ChangeRoomOutput =
  | {
      readonly kind: 'joined';
      readonly room: RealtimeRoom;
      readonly previousRoom: RealtimeRoom | null;
    }
  | { readonly kind: 'left'; readonly room: RealtimeRoom | null }
  | { readonly kind: 'not-found' | 'unavailable' | 'invalidated' | 'room-limit' };
