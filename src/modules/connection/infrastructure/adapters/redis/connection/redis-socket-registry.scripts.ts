import { socketAuthorityLua } from '../../../../../../infrastructure/redis/realtime-socket-authority.js';

// The marker window covers Identity's longest session (30 days) and one ticket (60 seconds).
const markerWindowMs = (30 * 24 * 60 * 60 + 60) * 1_000;
const maximumResourceRooms = 32;
const deliveryHandoffMs = 5_000;

/** Redis reply for a join refused because the socket already holds its resource room limit. */
export const socketRoomLimitReply = 'limit-reached';

/**
 * Operates on the socket, session marker, membership marker and organization epoch.
 * A socket caches the membership version at registration so even a role change followed
 * by a return to that role invalidates the earlier registrations.
 */
export const socketRegistryScript: string = `
${socketAuthorityLua}
local socket = KEYS[1]
local session = KEYS[2]
local member = KEYS[3]
local visibility = KEYS[4]
local organizationLease = KEYS[5]
local scopePrefix = KEYS[6]
local notice = KEYS[7]
local operation = ARGV[1]
local identity = ARGV[2]
local sessionVersion = tonumber(ARGV[3])
local role = ARGV[4]
local expiresAt = tonumber(ARGV[5])
local selector = ARGV[6]
local room = ARGV[7]
local expectedEpoch = ARGV[8]
local requestId = ARGV[9]
local deliveryChannel = ARGV[10]
local encodedDelivery = ARGV[11]
local spaceId = ARGV[12]
local listId = ARGV[13]
local socketId = ARGV[14]
local limitReply = '${socketRoomLimitReply}'

if operation == 'unregister' then
  if redis.call('HGET', socket, 'identity') == identity then redis.call('DEL', socket) end
  return 1
end

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local membership, organizationLeaseVersion =
  readSocketAuthority(session, member, organizationLease, sessionVersion, role, expiresAt, now)
if not membership then return false end
local membershipVersion = membership[1] or '0'

if operation == 'register' then
  local storedIdentity = redis.call('HGET', socket, 'identity')
  if storedIdentity then
    if redis.call('HGET', socket, 'registration') ~= requestId then return false end
    return currentSocketRegistration(socket, identity, membershipVersion, organizationLeaseVersion) ~= nil
  end
  if redis.call('EXISTS', socket) == 1 then return false end
  redis.call('HSET', socket, 'identity', identity, 'membership', membershipVersion,
    'organizationLease', organizationLeaseVersion, 'deliveryChannel', deliveryChannel,
    'registration', requestId, 'resourceRooms', 0,
    'selection:organization', selector, 'room:' .. selector, 'selection:organization',
    'room:' .. room, 'personal')
  redis.call('PEXPIREAT', socket, expiresAt)
  if membership[1] then redis.call('PEXPIREAT', member, expiresAt, 'GT') end
  return 1
end
local resourceRooms = currentSocketRegistration(socket, identity, membershipVersion, organizationLeaseVersion)
if not resourceRooms then return false end

local epoch = redis.call('GET', visibility) or '0'
if resourceRooms > 0 and (operation == 'read' or operation == 'has' or operation == 'publish')
  and redis.call('HGET', socket, 'checkedEpoch') ~= epoch then
  -- At most 32 resource rooms can have placement fields. Cache a successful check until the
  -- next visibility fact so ordinary delivery does not repeat the scan.
  for _, field in ipairs(redis.call('HKEYS', socket)) do
    if string.sub(field, 1, 10) == 'placement:' then
      local joinedAt, joinedSpace, joinedList = string.match(redis.call('HGET', socket, field),
        '^(%d+):([%w%-]+):([%w%-]+)$')
      if not joinedAt then return false end
      local keys = {scopePrefix .. 'space:' .. joinedSpace, scopePrefix .. 'list:' .. joinedList}
      local resourceSelector = string.sub(field, 11)
      if string.sub(resourceSelector, 1, 5) == 'task:' then
        table.insert(keys, scopePrefix .. resourceSelector)
      end
      for _, changedAt in ipairs(redis.call('MGET', unpack(keys))) do
        if changedAt and tonumber(changedAt) > tonumber(joinedAt) then return false end
      end
    end
  end
  redis.call('HSET', socket, 'checkedEpoch', epoch)
end
if operation == 'read' then return epoch end
if operation == 'has' then
  return epoch == expectedEpoch and redis.call('HEXISTS', socket, 'room:' .. room) == 1
end
if operation == 'publish' then
  if epoch ~= expectedEpoch or redis.call('HEXISTS', socket, 'room:' .. room) ~= 1 then
    return false
  end
  if notice ~= '' and redis.call('SISMEMBER', notice, socketId) == 1 then return 1 end
  local route = redis.call('HGET', socket, 'deliveryChannel')
  if not route then return 0 end
  local deadline = math.min(expiresAt, now + ${String(deliveryHandoffMs)})
  return redis.call('PUBLISH', route,
    '{"deadline":' .. tostring(deadline) .. ',"delivery":' .. encodedDelivery .. '}')
end
if (operation == 'join' or operation == 'evict') and epoch ~= expectedEpoch then return false end
if requestId ~= '' and redis.call('HGET', socket, 'lastRequest') == requestId then
  return redis.call('HGET', socket, 'lastRoom')
end

local selectionField = 'selection:' .. selector
local previous = redis.call('HGET', socket, selectionField)
local resource = selector ~= 'organization'
if operation == 'leave' or operation == 'evict' then
  if previous then
    redis.call('HDEL', socket, selectionField, 'room:' .. previous, 'placement:' .. selector)
    if resource then resourceRooms = resourceRooms - 1 end
  end
  redis.call('HSET', socket, 'resourceRooms', resourceRooms, 'lastRequest', requestId,
    'lastRoom', previous or '')
  return previous or ''
end
if operation ~= 'join' then return false end

local roomField = 'room:' .. room
local owner = redis.call('HGET', socket, roomField)
if owner and owner ~= selectionField then return false end
if resource and not previous then
  if resourceRooms >= ${String(maximumResourceRooms)} then
    redis.call('HSET', socket, 'lastRequest', requestId, 'lastRoom', limitReply)
    return limitReply
  end
  resourceRooms = resourceRooms + 1
end
if previous and previous ~= room then redis.call('HDEL', socket, 'room:' .. previous) end
redis.call('HSET', socket, selectionField, room, roomField, selectionField,
  'resourceRooms', resourceRooms, 'lastRequest', requestId, 'lastRoom', previous or '')
if resource and spaceId ~= '' and listId ~= '' then
  redis.call('HSET', socket, 'placement:' .. selector, epoch .. ':' .. spaceId .. ':' .. listId)
end
return previous or ''
`;

/** Keeps the greatest event version and makes terminal markers win over duplicate or late facts. */
export const markSocketInvalidationScript: string = `
local existing = redis.call('HMGET', KEYS[1], 'version', 'terminal')
local previousVersion = tonumber(existing[1] or '0')
local nextVersion = ARGV[1]
local terminal = ARGV[2] == '1'
if existing[2] == '1' or (not terminal and tonumber(nextVersion) <= previousVersion) then
  return 0
end
if tonumber(nextVersion) < previousVersion then nextVersion = existing[1] end
redis.call('HSET', KEYS[1], 'version', nextVersion, 'terminal', ARGV[2])
if ARGV[3] ~= '' then redis.call('HSET', KEYS[1], 'role', ARGV[3]) end
redis.call('PEXPIRE', KEYS[1], ${String(markerWindowMs)})
return 1
`;

/** Deduplicates a broad organization invalidation across retained broker redeliveries. */
export const invalidateOrganizationLeasesScript: string = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('INCR', KEYS[1])
redis.call('INCR', KEYS[2])
redis.call('PSETEX', KEYS[3], ${String(markerWindowMs)}, '1')
return 1
`;

/** Records the resource's last change only once without revoking unrelated socket leases. */
export const invalidateScopeScript: string = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('INCR', KEYS[1])
redis.call('PSETEX', KEYS[2], ${String(markerWindowMs)}, redis.call('GET', KEYS[1]))
redis.call('PSETEX', KEYS[3], ${String(markerWindowMs)}, '1')
return 1
`;
