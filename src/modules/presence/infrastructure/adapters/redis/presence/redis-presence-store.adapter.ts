import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import {
  membershipKey,
  organizationLeaseKey,
  sessionKey,
  socketAuthorityLua,
  socketIdentityFingerprint,
  socketRegistrationKey,
} from '../../../../../../infrastructure/redis/realtime-socket-authority.js';
import type { PresenceConnection } from '../../../../application/models/presence/presence.model.js';
import type { PresenceStatus } from '../../../../application/models/presence/presence-status.model.js';
import type { PresenceStore } from '../../../../application/ports/outbound/redis/presence/presence-store.port.js';

const dueKey = 'realtime:presence:due';
const leaseMs = 90_000;
const retentionMs = 86_400_000;
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type PresenceUpdate =
  | {
      readonly action: 'connect' | 'heartbeat';
      readonly connection: PresenceConnection;
    }
  | {
      readonly action: 'set';
      readonly connection: PresenceConnection;
      readonly status: PresenceStatus;
    }
  | {
      readonly action: 'disconnect' | 'expire';
      readonly connection: Pick<PresenceConnection, 'organizationId' | 'memberId' | 'socketId'>;
    };

// Redis serializes the lease update, visible transition and publication across instances.
const updateScript = `
${socketAuthorityLua}
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local action, socket, deadline, status = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]
local member, channel, lease, retention = ARGV[5], ARGV[6], tonumber(ARGV[7]), tonumber(ARGV[8])
if action == 'connect' or action == 'heartbeat' or action == 'set' then
  local membership, organizationLeaseVersion =
    readSocketAuthority(KEYS[5], KEYS[6], KEYS[7], tonumber(ARGV[13]), ARGV[14], deadline, now)
  if not membership or not currentSocketRegistration(
    KEYS[4], ARGV[12], membership[1] or '0', organizationLeaseVersion
  ) then return 0 end
end

local previous = redis.call('HGET', KEYS[2], 'visible') or 'offline'
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local active = redis.call('ZSCORE', KEYS[1], socket)
local accepted = 1
if action == 'connect' then
  redis.call('ZADD', KEYS[1], math.min(now + lease, deadline), socket)
elseif action == 'heartbeat' or action == 'set' then
  if not active then accepted = 0
  else
    redis.call('ZADD', KEYS[1], math.min(now + lease, deadline), socket)
    if action == 'set' then redis.call('HSET', KEYS[2], 'preference', status) end
  end
elseif action == 'disconnect' then
  redis.call('ZREM', KEYS[1], socket)
end
local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local last = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
local preference = redis.call('HGET', KEYS[2], 'preference') or 'online'
local visible = 'offline'
if #first > 0 and preference ~= 'invisible' then visible = preference end
redis.call('HSET', KEYS[2], 'visible', visible)
if #first > 0 then
  redis.call('ZADD', KEYS[3], first[2], member)
  redis.call('PEXPIREAT', KEYS[1], tonumber(last[2]) + retention)
  redis.call('PEXPIREAT', KEYS[2], tonumber(last[2]) + retention)
else
  redis.call('ZREM', KEYS[3], member)
  redis.call('PEXPIREAT', KEYS[2], now + retention)
end
if previous ~= visible then
  redis.call('PUBLISH', channel, cjson.encode({ memberId = ARGV[9], status = visible, id = ARGV[10], at = ARGV[11] }))
end
return accepted
`;

/** Redis-backed membership presence. Notifications contain only visible organization status. */
export class RedisPresenceStore implements PresenceStore {
  // #region Constructor
  /** Uses the shared connection with its offline queue disabled. */
  public constructor(private readonly redis: Redis) {}
  // #endregion

  // #region Methods
  /** Creates an expiring lease for an authorized connection. */
  public connect(connection: PresenceConnection): Promise<boolean> {
    return this.update({ action: 'connect', connection });
  }

  /** Refreshes an existing live lease. */
  public heartbeat(connection: PresenceConnection): Promise<boolean> {
    return this.update({ action: 'heartbeat', connection });
  }

  /** Sets the shared preference from a live connection. */
  public set(connection: PresenceConnection, status: PresenceStatus): Promise<boolean> {
    return this.update({ action: 'set', connection, status });
  }

  /** Releases only this socket's lease. */
  public async disconnect(connection: PresenceConnection): Promise<void> {
    await this.update({ action: 'disconnect', connection });
  }

  /** Atomically reconciles each member whose earliest socket lease has expired. */
  public async expire(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError('Invalid page size');
    const time = await this.redis.time();
    const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
    const due = await this.redis.zrangebyscore(dueKey, '-inf', now, 'LIMIT', 0, limit);
    for (const item of due) {
      const [organizationId, memberId] = item.split('/');
      if (organizationId === undefined || memberId === undefined)
        throw new Error('Invalid presence index');
      await this.update({
        action: 'expire',
        connection: { organizationId, memberId, socketId: '' },
      });
    }
    return due.length;
  }

  /** Validates socket authority and publishes any resulting transition in the same script. */
  private async update(update: PresenceUpdate): Promise<boolean> {
    const { action, connection } = update;
    const organizationId = connection.organizationId.toLowerCase();
    const memberId = connection.memberId.toLowerCase();
    if (!identifier.test(organizationId) || !identifier.test(memberId))
      throw new Error('Invalid presence scope');
    if (action !== 'expire' && !connection.socketId) throw new Error('Invalid presence connection');

    const authority =
      update.action === 'connect' || update.action === 'heartbeat' || update.action === 'set'
        ? update.connection
        : undefined;
    if (authority !== undefined && !Number.isSafeInteger(authority.expiresAt)) {
      throw new Error('Invalid presence connection deadline');
    }
    const member = `${organizationId}/${memberId}`;
    const base = `realtime:presence:${organizationId}:${memberId}`;
    const result = await this.redis.eval(
      updateScript,
      authority === undefined ? 3 : 7,
      `${base}:sockets`,
      `${base}:state`,
      dueKey,
      ...(authority === undefined
        ? []
        : [
            socketRegistrationKey(connection.socketId),
            sessionKey(authority.sessionId),
            membershipKey(organizationId, memberId),
            organizationLeaseKey(organizationId),
          ]),
      action,
      connection.socketId,
      authority?.expiresAt ?? 0,
      update.action === 'set' ? update.status : 'online',
      member,
      `realtime:presence:org:${organizationId}`,
      leaseMs,
      retentionMs,
      memberId,
      randomUUID(),
      new Date().toISOString(),
      ...(authority === undefined
        ? []
        : [socketIdentityFingerprint(authority), authority.sessionVersion, authority.role]),
    );
    return result === 1;
  }
  // #endregion
}
