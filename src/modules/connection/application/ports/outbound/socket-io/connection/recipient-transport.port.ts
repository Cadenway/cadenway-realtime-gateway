import type { ConnectionRecipient } from '../../../../models/connection/connection-recipient.model.js';

/** Finds and addresses Socket.IO registrations across gateway replicas. */
export interface RecipientTransport {
  // #region Methods
  /** Reads projected registrations from a server-owned room index. */
  read(room: string, includePending?: boolean): Promise<readonly ConnectionRecipient[]>;

  /** Streams bounded pages of ready recipients from a task or list delivery index. */
  scan(room: string, signal: AbortSignal): AsyncIterable<readonly ConnectionRecipient[]>;

  /** Leaves room indexes for one connection. */
  leave(recipient: ConnectionRecipient, rooms: readonly string[]): void;

  /** Closes a single transport across replicas. */
  disconnect(recipient: ConnectionRecipient): void;
  // #endregion
}
