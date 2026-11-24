import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { randomUUID } from 'node:crypto';
import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import { z } from 'zod';

import type { RealtimeSession } from '../../../../application/models/connection/realtime-session.model.js';
import type { RoomSelection } from '../../../../application/models/connection/room-selection.model.js';
import type { SocketPresencePage } from '../../../../application/models/connection/socket-presence-page.model.js';
import type { SocketPresenceStatus } from '../../../../application/models/connection/socket-presence-status.model.js';
import type { ChangeRoomOutput } from '../../../../application/use-cases/commands/connection/change-room/change-room.output.js';
import { ChangeRoom } from '../../../../application/use-cases/commands/connection/change-room/change-room.use-case.js';
import { CheckConnection } from '../../../../application/use-cases/commands/connection/check-connection/check-connection.use-case.js';
import { TrackSocketPresence } from '../../../../application/use-cases/commands/connection/track-socket-presence/track-socket-presence.use-case.js';

/** The public acknowledgement reveals neither the existence of hidden resources nor proof data. */
type RoomAcknowledgement =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        'request.invalid' | 'room.not-found' | 'room.limit-reached' | 'realtime.unavailable';
    };

/** A snapshot page, or a refusal that keeps the connection open unless authority was lost. */
type PresenceListAcknowledgement =
  | ({ readonly ok: true } & SocketPresencePage)
  | { readonly ok: false; readonly code: 'request.invalid' | 'realtime.unavailable' };

interface SocketConnection {
  // #region Properties
  /** Verified session and local readiness, room operation and expiry state. */
  readonly session: RealtimeSession;
  ready: boolean;
  changingRoom: boolean;
  changingPresence: boolean;
  listingPresence: boolean;
  nextHeartbeatAt: number;
  nextStatusChangeAt: number;
  nextPresenceListAt: number;
  expiry?: NodeJS.Timeout;

  /** The only cursor a continuation page accepts: the one returned by this socket's last page. */
  presenceCursor?: string;
  // #endregion
}

type ConnectionSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  { realtimeSession?: RealtimeSession; realtimeReady?: boolean }
>;

// Browser messages follow the Socket.IO extension in the published realtime AsyncAPI document.
const handshakeAuth = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) });
const roomSelection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('organization') }),
  z.strictObject({ kind: z.literal('list'), listId: z.uuid().transform((id) => id.toLowerCase()) }),
  z.strictObject({
    kind: z.literal('task'),
    taskKey: z.string().regex(/^[A-Z]{2,5}-[1-9][0-9]{0,8}$/u),
  }),
]);

const unavailable = { ok: false, code: 'realtime.unavailable' } as const;
const invalid = { ok: false, code: 'request.invalid' } as const;
const emptyPayload = z.strictObject({});
const presencePayload = z.strictObject({
  status: z.enum(['online', 'away', 'do-not-disturb', 'invisible']),
});
const presenceListPayload = z.strictObject({ cursor: z.string().min(1).max(128).optional() });
const heartbeatIntervalSeconds = 30;
const leaseCheckIntervalMs = 4_000;
const leaseCheckJitterMs = 1_000;
const leaseCheckTimeoutMs = 1_000;
const maximumConcurrentLeaseChecks = 64;
const maximumConcurrentAdmissions = 32;
const maximumConcurrentPresenceChanges = 32;
const heartbeatCooldownMs = 5_000;
const statusChangeCooldownMs = 1_000;
const presenceListCooldownMs = 5_000;

// Socket.IO can mutate connected during any awaited operation or deadline callback.
function isConnected(client: ConnectionSocket): boolean {
  return client.connected;
}

/** Socket.IO entry point. The shared IO adapter checks Origin before this gateway sees a socket. */
@WebSocketGateway()
export class RealtimeGateway
  implements OnGatewayConnection<ConnectionSocket>, OnGatewayDisconnect<ConnectionSocket>
{
  // #region Properties
  /** Socket.IO server used by the composition adapter for verified recipient delivery. */
  @WebSocketServer()
  public server?: Server;

  /** Local transport state only. The authoritative registration and fences live in Redis. */
  private readonly connections = new WeakMap<ConnectionSocket, SocketConnection>();

  /** Caps the lease rechecks this replica issues when sockets otherwise have no traffic. */
  private checkingLeases = 0;

  /** Keeps bounded work in flight even when Identity or Redis is slow. */
  private admitting = 0;
  private changingPresence = 0;
  // #endregion

  // #region Constructor
  /** Binds ticket lifecycle and subscription authorization to the Socket.IO transport. */
  public constructor(
    private readonly checkConnection: CheckConnection,
    private readonly changeRoom: ChangeRoom,
    private readonly presence: TrackSocketPresence,
  ) {}
  // #endregion

  // #region Methods
  /** Redeems a ticket once. No room packet or ready message is enabled before the fence recheck. */
  public async handleConnection(client: ConnectionSocket): Promise<void> {
    const auth = handshakeAuth.safeParse(client.handshake.auth);
    client.handshake.auth = {};
    if (!auth.success || this.admitting >= maximumConcurrentAdmissions) {
      client.disconnect(true);
      return;
    }

    this.admitting += 1;
    try {
      const session = await this.checkConnection.execute(client.id, auth.data.token);
      if (session === null) {
        client.disconnect(true);
        return;
      }
      if (!isConnected(client)) {
        await this.release(client.id, session);
        return;
      }
      const connection: SocketConnection = {
        session,
        ready: false,
        changingRoom: false,
        changingPresence: false,
        listingPresence: false,
        nextHeartbeatAt: 0,
        nextStatusChangeAt: 0,
        nextPresenceListAt: 0,
      };
      this.connections.set(client, connection);
      client.data.realtimeSession = session;
      this.armLeaseCheck(client, connection);
      if (!isConnected(client)) return;
      await client.join([
        `org:${session.organizationId}`,
        `member:${session.memberId}`,
        `session:${session.sessionId}`,
        `account:${session.organizationId}:${session.userId}`,
      ]);
      if (!(await this.checkConnection.isCurrent(client.id, session)) || !isConnected(client)) {
        client.disconnect(true);
        return;
      }
      if (!(await this.presence.execute(client.id, session))) {
        client.disconnect(true);
        return;
      }
      if (!isConnected(client)) {
        await this.release(client.id, session);
        return;
      }
      if (!(await this.checkConnection.isCurrent(client.id, session)) || !isConnected(client)) {
        client.disconnect(true);
        return;
      }

      connection.ready = true;
      client.data.realtimeReady = true;
      if (isConnected(client)) {
        client.emit('hello', {
          id: randomUUID(),
          type: 'connection.ready.v1',
          at: new Date().toISOString(),
          version: 1,
          data: {
            organizationId: session.organizationId,
            sessionExpiresAt: new Date(session.expiresAt).toISOString(),
            heartbeatIntervalSeconds,
          },
        });
      }
    } catch {
      client.disconnect(true);
    } finally {
      this.admitting -= 1;
    }
  }

  /** Clears the deadline and asks the registry to release only this socket. */
  public async handleDisconnect(client: ConnectionSocket): Promise<void> {
    const connection = this.connections.get(client);
    if (connection === undefined) return;

    this.connections.delete(client);
    connection.ready = false;
    delete client.data.realtimeReady;
    delete client.data.realtimeSession;
    clearTimeout(connection.expiry);
    await this.release(client.id, connection.session);
  }

  /** Validates and applies a room subscription for the current socket. */
  @SubscribeMessage('room:join')
  public async joinRoom(
    @ConnectedSocket() client: ConnectionSocket,
    @MessageBody() body: unknown,
  ): Promise<RoomAcknowledgement> {
    return this.change(client, body, 'join');
  }

  /** Leaves one subscription without rechecking the requested resource's existence. */
  @SubscribeMessage('room:leave')
  public async leaveRoom(
    @ConnectedSocket() client: ConnectionSocket,
    @MessageBody() body: unknown,
  ): Promise<RoomAcknowledgement> {
    return this.change(client, body, 'leave');
  }

  /** Refreshes the sender's existing presence lease within the verified session lifetime. */
  @SubscribeMessage('presence:heartbeat')
  public async heartbeat(
    @ConnectedSocket() client: ConnectionSocket,
    @MessageBody() body: unknown,
  ): Promise<RoomAcknowledgement> {
    if (!emptyPayload.safeParse(body).success) return invalid;
    return this.changePresence(client);
  }

  /** Changes the authenticated membership's presence without accepting a membership selector. */
  @SubscribeMessage('presence:set')
  public async setPresence(
    @ConnectedSocket() client: ConnectionSocket,
    @MessageBody() body: unknown,
  ): Promise<RoomAcknowledgement> {
    const checked = presencePayload.safeParse(body);
    if (!checked.success) return invalid;
    return this.changePresence(client, checked.data.status);
  }

  /**
   * Returns one snapshot page of the verified organization. A new snapshot is spaced by five
   * seconds per socket; a continuation accepts only the cursor of this socket's previous page.
   */
  @SubscribeMessage('presence:list')
  public async listPresence(
    @ConnectedSocket() client: ConnectionSocket,
    @MessageBody() body: unknown,
  ): Promise<PresenceListAcknowledgement> {
    const checked = presenceListPayload.safeParse(body);
    if (!checked.success) return invalid;
    const connection = this.connections.get(client);
    if (
      connection?.ready !== true ||
      !isConnected(client) ||
      connection.listingPresence ||
      this.changingPresence >= maximumConcurrentPresenceChanges
    ) {
      return unavailable;
    }
    const cursor = checked.data.cursor ?? null;
    if (cursor === null) {
      const now = performance.now();
      if (now < connection.nextPresenceListAt) return unavailable;
      connection.nextPresenceListAt = now + presenceListCooldownMs;
    } else if (cursor !== connection.presenceCursor) {
      return invalid;
    }
    delete connection.presenceCursor;
    connection.listingPresence = true;
    this.changingPresence += 1;
    try {
      const page = await this.presence.list(client.id, connection.session, cursor);
      if (
        page === null ||
        !(await this.checkConnection.isCurrent(client.id, connection.session)) ||
        !isConnected(client)
      ) {
        client.disconnect(true);
        return unavailable;
      }
      if (page.nextCursor !== null) connection.presenceCursor = page.nextCursor;
      return { ok: true, status: page.status, members: page.members, nextCursor: page.nextCursor };
    } catch {
      client.disconnect(true);
      return unavailable;
    } finally {
      connection.listingPresence = false;
      this.changingPresence -= 1;
    }
  }

  private async changePresence(
    client: ConnectionSocket,
    status?: SocketPresenceStatus,
  ): Promise<RoomAcknowledgement> {
    const connection = this.connections.get(client);
    if (
      connection?.ready !== true ||
      !isConnected(client) ||
      connection.changingPresence ||
      this.changingPresence >= maximumConcurrentPresenceChanges
    ) {
      return unavailable;
    }
    const now = performance.now();
    if (status === undefined) {
      if (now < connection.nextHeartbeatAt) return unavailable;
      connection.nextHeartbeatAt = now + heartbeatCooldownMs;
    } else {
      if (now < connection.nextStatusChangeAt) return unavailable;
      connection.nextStatusChangeAt = now + statusChangeCooldownMs;
    }
    connection.changingPresence = true;
    this.changingPresence += 1;
    try {
      if (
        !(await this.checkConnection.isCurrent(client.id, connection.session)) ||
        !isConnected(client)
      ) {
        client.disconnect(true);
        return unavailable;
      }
      const applied =
        status === undefined
          ? await this.presence.heartbeat(client.id, connection.session)
          : await this.presence.set(client.id, connection.session, status);
      if (applied === 'limited') return unavailable;
      if (
        !applied ||
        !(await this.checkConnection.isCurrent(client.id, connection.session)) ||
        !isConnected(client)
      ) {
        client.disconnect(true);
        return unavailable;
      }
      return { ok: true };
    } catch {
      client.disconnect(true);
      return unavailable;
    } finally {
      connection.changingPresence = false;
      this.changingPresence -= 1;
    }
  }

  private async change(
    client: ConnectionSocket,
    body: unknown,
    operation: 'join' | 'leave',
  ): Promise<RoomAcknowledgement> {
    const connection = this.connections.get(client);
    if (connection?.ready !== true || connection.changingRoom || !client.connected)
      return unavailable;
    const selection = roomSelection.safeParse(body);
    if (!selection.success) return invalid;

    // One in-flight mutation avoids a late authorization reviving a subscription after leave.
    connection.changingRoom = true;
    try {
      const result = await this.changeRoom.execute(
        operation,
        client.id,
        connection.session,
        selection.data,
      );
      return await this.applyRoomChange(client, connection.session, selection.data, result);
    } catch {
      // A failed registry or adapter operation may have been partially applied.
      client.disconnect(true);
      return unavailable;
    } finally {
      connection.changingRoom = false;
    }
  }

  private async applyRoomChange(
    client: ConnectionSocket,
    session: RealtimeSession,
    selection: RoomSelection,
    result: ChangeRoomOutput,
  ): Promise<RoomAcknowledgement> {
    if (!client.connected) return unavailable;
    switch (result.kind) {
      case 'not-found':
        return { ok: false, code: 'room.not-found' };
      case 'room-limit':
        return { ok: false, code: 'room.limit-reached' };
      case 'invalidated':
        client.disconnect(true);
        return unavailable;
      case 'unavailable':
        return unavailable;
      case 'left':
        if (result.room !== null) await client.leave(result.room);
        if (selection.kind === 'task') {
          await client.leave(`task-key:${session.organizationId}:${selection.taskKey}`);
        }
        break;
      case 'joined':
        if (result.previousRoom !== null && result.previousRoom !== result.room) {
          await client.leave(result.previousRoom);
        }
        if (!isConnected(client)) return unavailable;
        await client.join(
          selection.kind === 'task'
            ? [result.room, `task-key:${session.organizationId}:${selection.taskKey}`]
            : result.room,
        );
        break;
    }

    if (!(await this.checkConnection.isCurrent(client.id, session)) || !isConnected(client)) {
      client.disconnect(true);
      return unavailable;
    }
    return { ok: true };
  }

  /** Forces idle sockets to observe revocation despite a lost cross-replica close hint. */
  private armLeaseCheck(client: ConnectionSocket, connection: SocketConnection): void {
    const remainingMs = connection.session.expiresAt - Date.now();
    if (remainingMs <= 0) {
      client.disconnect(true);
      return;
    }
    connection.expiry = setTimeout(
      () => {
        void this.checkLease(client, connection);
      },
      Math.min(remainingMs, leaseCheckIntervalMs + Math.floor(Math.random() * leaseCheckJitterMs)),
    ).unref();
  }

  /** Closes when the deadline, the shared fence or the bounded recheck budget has been lost. */
  private async checkLease(client: ConnectionSocket, connection: SocketConnection): Promise<void> {
    if (!isConnected(client)) return;
    const remainingMs = connection.session.expiresAt - Date.now();
    if (remainingMs <= 0 || this.checkingLeases >= maximumConcurrentLeaseChecks) {
      client.disconnect(true);
      return;
    }

    this.checkingLeases += 1;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<boolean>((resolve) => {
        timeout = setTimeout(
          () => {
            resolve(false);
          },
          Math.min(remainingMs, leaseCheckTimeoutMs),
        ).unref();
      });
      const current = await Promise.race([
        deadline,
        this.checkConnection.isCurrent(client.id, connection.session),
      ]);
      if (!current) client.disconnect(true);
      else if (isConnected(client)) this.armLeaseCheck(client, connection);
    } catch {
      client.disconnect(true);
    } finally {
      clearTimeout(timeout);
      this.checkingLeases -= 1;
    }
  }

  private async release(socketId: string, session: RealtimeSession): Promise<void> {
    // Both leases remain bounded if their cleanup cannot reach Redis.
    await Promise.allSettled([
      this.checkConnection.release(socketId, session),
      this.presence.disconnect(socketId, session),
    ]);
  }
  // #endregion
}
