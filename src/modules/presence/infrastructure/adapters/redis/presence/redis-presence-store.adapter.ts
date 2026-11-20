import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import type { PresenceConnection } from '../../../../application/models/presence/presence.model.js';
import type { PresenceStatus } from '../../../../application/models/presence/presence-status.model.js';
import type { PresenceStore } from '../../../../application/ports/outbound/redis/presence/presence-store.port.js';

const dueKey = 'realtime:presence:due';
const leaseMs = 90_000;
const retentionMs = 86_400_000;
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// Redis serializes the lease update, visible transition and publication across instances.
const updateScript = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local action, socket, deadline, status = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]
local member, channel, lease, retention = ARGV[5], ARGV[6], tonumber(ARGV[7]), tonumber(ARGV[8])
local previous = redis.call('HGET', KEYS[2], 'visible') or 'offline'
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local active = redis.call('ZSCORE', KEYS[1], socket)
local accepted = 1
if action == 'connect' then
  if deadline <= now then accepted = 0
  else redis.call('ZADD', KEYS[1], math.min(now + lease, deadline), socket) end
elseif action == 'heartbeat' or action == 'set' then
  if not active or deadline <= now then accepted = 0
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
    return this.update('connect', connection);
  }

  /** Refreshes an existing live lease. */
  public heartbeat(connection: PresenceConnection): Promise<boolean> {
    return this.update('heartbeat', connection);
  }

  /** Sets the shared preference from a live connection. */
  public set(connection: PresenceConnection, status: PresenceStatus): Promise<boolean> {
    return this.update('set', connection, status);
  }

  /** Releases only this socket's lease. */
  public async disconnect(connection: PresenceConnection): Promise<void> {
    await this.update('disconnect', connection);
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
      await this.update('expire', { organizationId, memberId, socketId: '', sessionExpiresAt: 0 });
    }
    return due.length;
  }

  /** Runs one transition and publishes only on the authenticated organization's channel. */
  private async update(
    action: 'connect' | 'heartbeat' | 'set' | 'disconnect' | 'expire',
    connection: PresenceConnection,
    status: PresenceStatus = 'online',
  ): Promise<boolean> {
    const organizationId = connection.organizationId.toLowerCase();
    const memberId = connection.memberId.toLowerCase();
    if (!identifier.test(organizationId) || !identifier.test(memberId))
      throw new Error('Invalid presence scope');
    if (
      action !== 'expire' &&
      (!connection.socketId || !Number.isSafeInteger(connection.sessionExpiresAt))
    ) {
      throw new Error('Invalid presence connection');
    }
    const member = `${organizationId}/${memberId}`;
    const base = `realtime:presence:${organizationId}:${memberId}`;
    const result = await this.redis.eval(
      updateScript,
      3,
      `${base}:sockets`,
      `${base}:state`,
      dueKey,
      action,
      connection.socketId,
      connection.sessionExpiresAt,
      status,
      member,
      `realtime:presence:org:${organizationId}`,
      leaseMs,
      retentionMs,
      memberId,
      randomUUID(),
      new Date().toISOString(),
    );
    return result === 1;
  }
  // #endregion
}
