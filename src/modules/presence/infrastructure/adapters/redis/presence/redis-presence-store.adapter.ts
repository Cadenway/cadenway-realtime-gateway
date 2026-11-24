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
import type { PresencePage } from '../../../../application/models/presence/presence-page.model.js';
import type { VisiblePresence } from '../../../../application/models/presence/visible-presence.model.js';
import type { VisiblePresenceStatus } from '../../../../application/models/presence/visible-presence-status.model.js';
import type { PresenceStatus } from '../../../../application/models/presence/presence-status.model.js';
import type { PresenceStore } from '../../../../application/ports/outbound/redis/presence/presence-store.port.js';

const dueKey = 'realtime:presence:due';
const pageSize = 100;
const leaseMs = 90_000;
const retentionMs = 86_400_000;
const statusChangeCooldownMs = 1_000;
const statusOrganizationLimit = 24;
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
    readSocketAuthority(KEYS[7], KEYS[8], KEYS[9], tonumber(ARGV[13]), ARGV[14], deadline, now)
  if not membership or not currentSocketRegistration(
    KEYS[6], ARGV[12], membership[1] or '0', organizationLeaseVersion
  ) then return 0 end
end

local previous = redis.call('HGET', KEYS[2], 'visible') or 'offline'
if action == 'set' then
  local leaseExpiry = tonumber(redis.call('ZSCORE', KEYS[1], socket) or '0')
  if leaseExpiry <= now then return 0 end
  local preference = redis.call('HGET', KEYS[2], 'preference') or 'online'
  if preference ~= status then
    local changedAt = tonumber(redis.call('HGET', KEYS[2], 'changedAt') or '0')
    if now - changedAt < ${String(statusChangeCooldownMs)} then return 2 end
    local usage = tonumber(redis.call('GET', KEYS[10]) or '0')
    if usage >= ${String(statusOrganizationLimit)} then return 2 end
    if redis.call('INCR', KEYS[10]) == 1 then
      redis.call('PEXPIRE', KEYS[10], ${String(statusChangeCooldownMs)})
    end
    redis.call('HSET', KEYS[2], 'changedAt', now)
  end
end
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
if visible == 'offline' then
  redis.call('ZREM', KEYS[4], ARGV[9])
  redis.call('HDEL', KEYS[5], ARGV[9])
else
  -- Equal scores order the snapshot index by member ID. The value keeps the last lease expiry.
  redis.call('ZADD', KEYS[4], 0, ARGV[9])
  redis.call('HSET', KEYS[5], ARGV[9], visible .. ':' .. last[2])
  redis.call('PEXPIRE', KEYS[4], retention)
  redis.call('PEXPIRE', KEYS[5], retention)
end
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

// The snapshot page is read in the script that checks the socket authority, so a revoked
// registration cannot read it. Expired leases are omitted before the expiry worker publishes them.
const listScript = `
${socketAuthorityLua}
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local membership, organizationLeaseVersion =
  readSocketAuthority(KEYS[4], KEYS[5], KEYS[6], tonumber(ARGV[2]), ARGV[3], tonumber(ARGV[4]), now)
if not membership or not currentSocketRegistration(
  KEYS[3], ARGV[1], membership[1] or '0', organizationLeaseVersion
) then return false end
local start = '-'
if ARGV[5] ~= '' then start = '(' .. ARGV[5] end
local ids = redis.call('ZRANGE', KEYS[1], start, '+', 'BYLEX', 'LIMIT', 0, ${String(pageSize)})
local reply = { redis.call('HGET', KEYS[7], 'preference') or 'online', '' }
if #ids == ${String(pageSize)} then reply[2] = ids[#ids] end
if #ids > 0 then
  local values = redis.call('HMGET', KEYS[2], unpack(ids))
  for index, id in ipairs(ids) do
    local status, deadline = string.match(values[index] or '', '^([%a%-]+):(%d+)$')
    if status and tonumber(deadline) > now then
      table.insert(reply, id)
      table.insert(reply, status)
    end
  end
end
return reply
`;

/** Ordered index of the members whose visible status is not offline, by organization. */
function visibleIndexKey(organizationId: string): string {
  return `realtime:presence:visible:${organizationId}`;
}

/** Visible status and last lease expiry of each indexed member, by organization. */
function visibleStatusKey(organizationId: string): string {
  return `realtime:presence:visible-status:${organizationId}`;
}

/** Validates the list script reply: own preference, next cursor, then member and status pairs. */
function readPage(reply: unknown): PresencePage {
  if (!Array.isArray(reply) || reply.length < 2 || reply.length % 2 !== 0)
    throw new Error('Unexpected Redis presence reply');
  const [status, next, ...pairs] = reply as unknown[];
  if (typeof status !== 'string' || !isPresenceStatus(status) || typeof next !== 'string')
    throw new Error('Unexpected Redis presence reply');
  if (next !== '' && !identifier.test(next)) throw new Error('Unexpected Redis presence reply');
  const members: VisiblePresence[] = [];
  for (let index = 0; index < pairs.length; index += 2) {
    const memberId = pairs[index];
    const visible = pairs[index + 1];
    if (
      typeof memberId !== 'string' ||
      !identifier.test(memberId) ||
      typeof visible !== 'string' ||
      !isVisibleStatus(visible)
    )
      throw new Error('Unexpected Redis presence reply');
    members.push({ memberId, status: visible });
  }
  return { status, members, nextCursor: next === '' ? null : next };
}

function isPresenceStatus(value: string): value is PresenceStatus {
  return value === 'invisible' || isVisibleStatus(value);
}

function isVisibleStatus(value: string): value is VisiblePresenceStatus {
  return value === 'online' || value === 'away' || value === 'do-not-disturb';
}

/** Redis-backed membership presence. Notifications contain only visible organization status. */
export class RedisPresenceStore implements PresenceStore {
  // #region Constructor
  /** Uses the shared connection with its offline queue disabled. */
  public constructor(private readonly redis: Redis) {}
  // #endregion

  // #region Methods
  /** Creates an expiring lease for an authorized connection. */
  public async connect(connection: PresenceConnection): Promise<boolean> {
    return (await this.update({ action: 'connect', connection })) === true;
  }

  /** Refreshes an existing live lease. */
  public async heartbeat(connection: PresenceConnection): Promise<boolean> {
    return (await this.update({ action: 'heartbeat', connection })) === true;
  }

  /** Sets the shared preference from a live connection. */
  public set(connection: PresenceConnection, status: PresenceStatus): Promise<boolean | 'limited'> {
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

  /** Reads one page of the verified organization while Redis still accepts the socket authority. */
  public async list(
    connection: PresenceConnection,
    cursor: string | null,
  ): Promise<PresencePage | null> {
    const organizationId = connection.organizationId.toLowerCase();
    const memberId = connection.memberId.toLowerCase();
    if (!identifier.test(organizationId) || !identifier.test(memberId))
      throw new Error('Invalid presence scope');
    if (cursor !== null && !identifier.test(cursor))
      throw new RangeError('Invalid presence cursor');
    if (!connection.socketId || !Number.isSafeInteger(connection.expiresAt))
      throw new Error('Invalid presence connection');

    const reply = await this.redis.eval(
      listScript,
      7,
      visibleIndexKey(organizationId),
      visibleStatusKey(organizationId),
      socketRegistrationKey(connection.socketId),
      sessionKey(connection.sessionId),
      membershipKey(organizationId, memberId),
      organizationLeaseKey(organizationId),
      `realtime:presence:${organizationId}:${memberId}:state`,
      socketIdentityFingerprint(connection),
      connection.sessionVersion,
      connection.role,
      connection.expiresAt,
      cursor ?? '',
    );
    return reply === null ? null : readPage(reply);
  }

  /** Validates socket authority and publishes any resulting transition in the same script. */
  private async update(update: PresenceUpdate): Promise<boolean | 'limited'> {
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
      authority === undefined ? 5 : 10,
      `${base}:sockets`,
      `${base}:state`,
      dueKey,
      visibleIndexKey(organizationId),
      visibleStatusKey(organizationId),
      ...(authority === undefined
        ? []
        : [
            socketRegistrationKey(connection.socketId),
            sessionKey(authority.sessionId),
            membershipKey(organizationId, memberId),
            organizationLeaseKey(organizationId),
            `realtime:presence:status-admission:${organizationId}`,
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
    return result === 2 ? 'limited' : result === 1;
  }
  // #endregion
}
