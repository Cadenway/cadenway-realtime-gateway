import { createHash, randomUUID } from 'node:crypto';

import {
  membershipKey,
  organizationLeaseKey,
  sessionKey,
  socketIdentityFingerprint,
  socketRegistrationKey,
  socketRegistryPrefix,
} from '../../../../../../infrastructure/redis/realtime-socket-authority.js';
import type { RealtimeRoom } from '../../../../application/models/connection/realtime-room.model.js';
import type { ConnectionRoomProof } from '../../../../application/models/connection/connection-room-proof.model.js';
import type { RealtimeSession } from '../../../../application/models/connection/realtime-session.model.js';
import type { RoomSelection } from '../../../../application/models/connection/room-selection.model.js';
import type { SocketRegistryJoin } from '../../../../application/models/connection/socket-registry-join.model.js';
import type { SocketRegistryPort } from '../../../../application/ports/outbound/redis/connection/socket-registry.port.js';
import {
  invalidateOrganizationLeasesScript,
  invalidateScopeScript,
  markSocketInvalidationScript,
  socketRegistryScript,
  socketRoomLimitReply,
} from './redis-socket-registry.scripts.js';

type RegistryOperation =
  'register' | 'read' | 'join' | 'leave' | 'unregister' | 'has' | 'evict' | 'publish';

interface RedisRegistryCommands {
  // #region Methods
  /** Executes a script when its digest is absent from the Redis cache. */
  eval(script: string, keyCount: number, ...parts: string[]): Promise<unknown>;

  /** Executes a previously cached script. */
  evalsha(digest: string, keyCount: number, ...parts: string[]): Promise<unknown>;

  /** Advances a visibility epoch. */
  incr(key: string): Promise<number>;
  // #endregion
}

const maximumHandoffBytes = 8_192;
const socketScriptDigest = createHash('sha1').update(socketRegistryScript).digest('hex');
const markerScriptDigest = createHash('sha1').update(markSocketInvalidationScript).digest('hex');
const organizationLeaseDigest = createHash('sha1')
  .update(invalidateOrganizationLeasesScript)
  .digest('hex');
const scopeDigest = createHash('sha1').update(invalidateScopeScript).digest('hex');

function scopePrefix(organizationId: string): string {
  return `${socketRegistryPrefix}scope:${encodeURIComponent(organizationId.toLowerCase())}:`;
}

function visibilityKey(organizationId: string): string {
  return `${socketRegistryPrefix}visibility:${encodeURIComponent(organizationId.toLowerCase())}`;
}

function selectorOf(selection: RoomSelection): string {
  switch (selection.kind) {
    case 'organization':
      return 'organization';
    case 'list':
      return `list:${selection.listId}`;
    case 'task':
      return `task:${selection.taskKey}`;
  }
}

function decodeRoom(value: unknown): RealtimeRoom | null {
  if (value === null || value === '') return null;
  if (typeof value === 'string' && /^((org|member|list|task):[0-9a-z-]+)$/iu.test(value)) {
    return value as RealtimeRoom;
  }
  throw new Error('Unexpected Redis socket registry reply.');
}

/** Shares lease checks, authorized subscriptions and invalidation fences across instances. */
export class RedisSocketRegistry implements SocketRegistryPort {
  // #region Properties
  /** Private channel of the replica that creates a socket registration. */
  public readonly deliveryChannel: string = `${socketRegistryPrefix}delivery:${randomUUID()}`;
  // #endregion

  // #region Constructor
  /** Uses the shared Redis connection with its offline command queue disabled. */
  public constructor(private readonly redis: RedisRegistryCommands) {}
  // #endregion

  // #region Methods
  /** Registers exactly one socket and its own organization and personal subscriptions. */
  public async register(socketId: string, session: RealtimeSession): Promise<boolean> {
    const reply = await this.socket(
      socketId,
      session,
      'register',
      `org:${session.organizationId}`,
      `member:${session.memberId}`,
    );
    return reply === 1;
  }

  /** Returns the current organization epoch only if the registration is still valid. */
  public async readFence(socketId: string, session: RealtimeSession): Promise<string | null> {
    const reply = await this.socket(socketId, session, 'read');
    if (reply === null || (typeof reply === 'string' && /^\d+$/u.test(reply))) return reply;
    throw new Error('Unexpected Redis socket registry reply.');
  }

  /** Writes the room only when the epoch from the authoritative access check is still valid. */
  public async join(
    socketId: string,
    session: RealtimeSession,
    fence: string,
    selection: RoomSelection,
    room: RealtimeRoom,
    placement?: ConnectionRoomProof,
  ): Promise<SocketRegistryJoin> {
    if (selection.kind === 'organization' && room !== `org:${session.organizationId}`) return null;
    if (selection.kind === 'list' && room !== `list:${selection.listId}`) return null;
    if (selection.kind === 'task' && !room.startsWith('task:')) return null;

    const reply = await this.socket(
      socketId,
      session,
      'join',
      selectorOf(selection),
      room,
      fence,
      '',
      placement,
    );
    if (reply === null) return null;
    if (reply === socketRoomLimitReply) return { kind: 'room-limit' };
    return { kind: 'joined', previousRoom: decodeRoom(reply) };
  }

  /** Removes the socket's own selector and returns its previous room. */
  public async leave(
    socketId: string,
    session: RealtimeSession,
    selection: RoomSelection,
  ): Promise<RealtimeRoom | null> {
    return decodeRoom(await this.socket(socketId, session, 'leave', selectorOf(selection)));
  }

  /** Releases only a registration with the same verified identity and deadline. */
  public async unregister(socketId: string, session: RealtimeSession): Promise<void> {
    await this.socket(socketId, session, 'unregister');
  }

  /** Rechecks exactly the subscription and epoch after the resource owner authorizes delivery. */
  public async hasSubscription(
    socketId: string,
    session: RealtimeSession,
    fence: string,
    room: RealtimeRoom,
  ): Promise<boolean> {
    return (await this.socket(socketId, session, 'has', '', room, fence)) === 1;
  }

  /** Atomically validates the registration and publishes a bounded notice to its owning replica. */
  public async publish(
    socketId: string,
    session: RealtimeSession,
    fence: string,
    room: RealtimeRoom,
    packet: unknown,
  ): Promise<boolean> {
    const delivery = JSON.stringify({ socketId, room, fence, packet });
    if (Buffer.byteLength(delivery) > maximumHandoffBytes) {
      throw new Error('Realtime delivery is too large.');
    }
    const reply = await this.socket(socketId, session, 'publish', '', room, fence, delivery);
    if (reply === null) return false;
    if (typeof reply === 'number' && reply > 0) return true;
    throw new Error('The realtime recipient replica is unavailable.');
  }

  /** Removes a resource selector only if the checked visibility epoch is still current. */
  public async evict(
    socketId: string,
    session: RealtimeSession,
    fence: string,
    selection: RoomSelection,
  ): Promise<RealtimeRoom | null> {
    if (selection.kind === 'organization') return null;
    return decodeRoom(
      await this.socket(socketId, session, 'evict', selectorOf(selection), '', fence),
    );
  }

  /** Fences lower session versions before the caller evicts old organization contexts. */
  public async markOrganizationChanged(sessionId: string, version: number): Promise<void> {
    await this.mark(sessionKey(sessionId), version, false, '');
  }

  /** Fences all versions of a session before the caller evicts its sockets. */
  public async markSessionRevoked(sessionId: string, version: number): Promise<void> {
    await this.mark(sessionKey(sessionId), version, true, '');
  }

  /** Fences earlier registrations and role mismatches before the caller evicts affected sockets. */
  public async markMembershipRole(
    organizationId: string,
    memberId: string,
    version: number,
    role: RealtimeSession['role'],
  ): Promise<void> {
    await this.mark(membershipKey(organizationId, memberId), version, false, role);
  }

  /** Fences a removed membership within its tenant before the caller evicts its sockets. */
  public async markMembershipRemoved(
    organizationId: string,
    memberId: string,
    version: number,
  ): Promise<void> {
    await this.mark(membershipKey(organizationId, memberId), version, true, '');
  }

  /** Advances the tenant epoch before handling access, placement or lifecycle invalidation. */
  public async advanceVisibility(organizationId: string): Promise<void> {
    try {
      await this.redis.incr(visibilityKey(organizationId));
    } catch {
      throw new Error('Redis socket registry is unavailable.');
    }
  }

  /** Advances both tenant epochs once per producer fact. The oldest sockets observe it locally. */
  public async invalidateOrganizationLeases(organizationId: string, factId: string): Promise<void> {
    await this.run(
      invalidateOrganizationLeasesScript,
      organizationLeaseDigest,
      [
        visibilityKey(organizationId),
        organizationLeaseKey(organizationId),
        `${socketRegistryPrefix}organization-fact:${encodeURIComponent(organizationId.toLowerCase())}:${encodeURIComponent(factId.toLowerCase())}`,
      ],
      [],
    );
  }

  /** Advances the generation for just one resource and fences stale in-flight proof reads. */
  public async invalidateScope(
    organizationId: string,
    kind: 'space' | 'list' | 'task',
    scopeId: string,
    factId: string,
  ): Promise<void> {
    const prefix = scopePrefix(organizationId);
    await this.run(
      invalidateScopeScript,
      scopeDigest,
      [visibilityKey(organizationId), `${prefix}${kind}:${scopeId}`, `${prefix}fact:${factId}`],
      [],
    );
  }

  private socket(
    socketId: string,
    session: RealtimeSession,
    operation: RegistryOperation,
    selector = '',
    room = '',
    fence = '',
    delivery = '',
    placement?: ConnectionRoomProof,
  ): Promise<unknown> {
    // ioredis may resend a command when the connection drops before its reply.
    const requestId =
      operation === 'register' ||
      operation === 'join' ||
      operation === 'leave' ||
      operation === 'evict'
        ? randomUUID()
        : '';
    return this.run(
      socketRegistryScript,
      socketScriptDigest,
      [
        socketRegistrationKey(socketId),
        sessionKey(session.sessionId),
        membershipKey(session.organizationId, session.memberId),
        visibilityKey(session.organizationId),
        organizationLeaseKey(session.organizationId),
        scopePrefix(session.organizationId),
      ],
      [
        operation,
        socketIdentityFingerprint(session),
        String(session.sessionVersion),
        session.role,
        String(session.expiresAt),
        selector,
        room,
        fence,
        requestId,
        operation === 'register' ? this.deliveryChannel : '',
        delivery,
        placement?.spaceId ?? '',
        placement?.listId ?? '',
      ],
    );
  }

  private async mark(
    key: string,
    version: number,
    terminal: boolean,
    role: RealtimeSession['role'] | '',
  ): Promise<void> {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error('Invalid socket invalidation version.');
    }
    await this.run(
      markSocketInvalidationScript,
      markerScriptDigest,
      [key],
      [String(version), terminal ? '1' : '0', role],
    );
  }

  /** Sends the cached script digest on the hot path and loads the script on a cache miss. */
  private async run(
    script: string,
    digest: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown> {
    try {
      try {
        return await this.redis.evalsha(digest, keys.length, ...keys, ...args);
      } catch (error: unknown) {
        if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT ')) throw error;
        return await this.redis.eval(script, keys.length, ...keys, ...args);
      }
    } catch {
      throw new Error('Redis socket registry is unavailable.');
    }
  }
  // #endregion
}
