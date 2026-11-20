import type { Server, Socket } from 'socket.io';
import { z } from 'zod';

import type { ConnectionRecipient } from '../../../../application/models/connection/connection-recipient.model.js';
import type { RealtimeRoom } from '../../../../application/models/connection/realtime-room.model.js';
import type { RealtimeSession } from '../../../../application/models/connection/realtime-session.model.js';
import type { RecipientTransport } from '../../../../application/ports/outbound/socket-io/connection/recipient-transport.port.js';
import type { RedisSocketRegistry } from '../../redis/connection/redis-socket-registry.adapter.js';

const sessionSchema = z.strictObject({
  sessionId: z.uuid(),
  sessionVersion: z.int().positive(),
  expiresAt: z.int().positive(),
  organizationId: z.uuid(),
  memberId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(['owner', 'admin', 'member', 'guest']),
});

const projectionSchema = z.object({
  realtimeReady: z.boolean().optional(),
  realtimeSession: sessionSchema,
});

const socketRoom = z.custom<RealtimeRoom>(
  (value) => typeof value === 'string' && /^(org|member|list|task):[0-9a-f-]{36}$/u.test(value),
);

const handoffSchema = z.strictObject({
  deadline: z.int().positive(),
  delivery: z.strictObject({
    socketId: z.string().min(1).max(128),
    room: socketRoom,
    fence: z.string().regex(/^[0-9]{1,20}$/u),
    packet: z.record(z.string(), z.unknown()),
  }),
});

// The wire envelope adds only its computed deadline and nesting above the publisher's lease bound.
const maximumHandoffWireBytes = 8_256;
const presenceDeliveryMs = 5_000;

function isInLocalRoom(socket: Socket, room: RealtimeRoom): boolean {
  return socket.connected && socket.rooms.has(room);
}

/** Uses server-owned Socket.IO indexes and the Redis adapter for cross-instance control. */
export class SocketIoRecipients implements RecipientTransport {
  // #region Constructor
  /** Resolves the active Socket.IO server after Nest initializes the gateway. */
  public constructor(
    private readonly server: () => Server | undefined,
    private readonly registry: Pick<RedisSocketRegistry, 'readFence' | 'hasSubscription'>,
    private readonly available: () => boolean,
  ) {}
  // #endregion

  // #region Methods
  /** Returns verified sockets, including pending admission only to fence them. */
  public async read(room: string, includePending = false): Promise<readonly ConnectionRecipient[]> {
    const sockets = await this.readyServer().in(room).fetchSockets();
    return sockets.flatMap((socket) => {
      const verified = projectionSchema.safeParse(socket.data);
      if (!verified.success || (!includePending && verified.data.realtimeReady !== true)) return [];
      return [{ socketId: socket.id, session: verified.data.realtimeSession }];
    });
  }

  /** Handles the replica's internal handoff and emits only to a still-authorized local socket. */
  public async receive(serialized: string): Promise<void> {
    if (!this.available() || Buffer.byteLength(serialized) > maximumHandoffWireBytes) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized) as unknown;
    } catch {
      return;
    }
    const parsed = handoffSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.deadline <= Date.now()) return;
    const { deadline, delivery } = parsed.data;
    const socket = this.readyServer().sockets.sockets.get(delivery.socketId);
    if (socket === undefined) return;
    const session = this.readySession(socket);
    if (session === null) return;
    await this.emitLocal(socket, session, delivery.room, delivery.fence, deadline, delivery.packet);
  }

  /** Rechecks only this replica's organization sockets before emitting a visible presence change. */
  public async deliverPresence(organizationId: string, packet: unknown): Promise<void> {
    if (!this.available()) return;
    const namespace = this.readyServer().sockets;
    const room = `org:${organizationId}` as const;
    const members = namespace.adapter.rooms.get(room);
    if (members === undefined) return;
    const deadline = Date.now() + presenceDeliveryMs;
    for (const id of members) {
      if (!this.available() || Date.now() >= deadline) return;
      const socket = namespace.sockets.get(id);
      if (socket === undefined) continue;
      const session = this.readySession(socket);
      if (session?.organizationId !== organizationId) continue;
      const fence = await this.registry.readFence(id, session);
      if (fence !== null) await this.emitLocal(socket, session, room, fence, deadline, packet);
    }
  }

  /** Leaves only the selected indexes for one socket. */
  public leave(recipient: ConnectionRecipient, rooms: readonly string[]): void {
    this.readyServer()
      .in(recipient.socketId)
      .socketsLeave([...rooms]);
  }

  /** Closes a single socket across gateway instances. */
  public disconnect(recipient: ConnectionRecipient): void {
    this.readyServer().in(recipient.socketId).disconnectSockets(true);
  }

  /** Rechecks the owner state after Redis returns and emits synchronously on the local transport. */
  private async emitLocal(
    socket: Socket,
    session: RealtimeSession,
    room: RealtimeRoom,
    fence: string,
    deadline: number,
    packet: unknown,
  ): Promise<void> {
    if (!isInLocalRoom(socket, room)) return;
    const allowed = await this.registry.hasSubscription(socket.id, session, fence, room);
    if (
      allowed &&
      this.available() &&
      isInLocalRoom(socket, room) &&
      Date.now() < Math.min(deadline, session.expiresAt)
    ) {
      socket.volatile.emit('change', packet);
    }
  }

  private readySession(socket: Socket): RealtimeSession | null {
    const checked = projectionSchema.safeParse(socket.data);
    return checked.success && checked.data.realtimeReady === true
      ? checked.data.realtimeSession
      : null;
  }

  private readyServer(): Server {
    const server = this.server();
    if (server === undefined) throw new Error('Realtime transport is unavailable.');
    return server;
  }
  // #endregion
}
