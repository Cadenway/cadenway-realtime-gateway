import type { RealtimeSession } from '../../../../models/connection/realtime-session.model.js';

/** Checks resource visibility at Task with the verified account and organization. */
export interface RoomAccessPort {
  // #region Methods
  /** Signs the request with this session's user and tenant. Missing and hidden lists return null. */
  list(
    session: RealtimeSession,
    listId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly organizationId: string;
    readonly listId: string;
    readonly spaceId: string;
  } | null>;

  /** Returns Task's stable UUID and canonical key. A legacy response without UUID is refused. */
  task(
    session: RealtimeSession,
    taskKey: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly organizationId: string;
    readonly listId: string;
    readonly spaceId: string;
    readonly taskKey: string;
    readonly taskId?: string;
  } | null>;
  // #endregion
}
