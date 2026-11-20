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
local socket = KEYS[1]
local session = KEYS[2]
local member = KEYS[3]
local visibility = KEYS[4]
local organizationLease = KEYS[5]
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
local limitReply = '${socketRoomLimitReply}'

local storedIdentity = redis.call('HGET', socket, 'identity')
if operation == 'unregister' then
  if storedIdentity == identity then redis.call('DEL', socket) end
  return 1
end

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not expiresAt or expiresAt <= now or not sessionVersion or sessionVersion < 1 then
  return false
end
if operation == 'register' then
  if storedIdentity then
    if storedIdentity ~= identity or redis.call('HGET', socket, 'registration') ~= requestId then
      return false
    end
  elseif redis.call('EXISTS', socket) == 1 then
    return false
  end
elseif storedIdentity ~= identity then
  return false
end

local sessionMarker = redis.call('HMGET', session, 'version', 'terminal')
if sessionMarker[2] == '1' or tonumber(sessionMarker[1] or '0') > sessionVersion then
  return false
end
local membership = redis.call('HMGET', member, 'version', 'terminal', 'role')
local membershipVersion = membership[1] or '0'
if membership[2] == '1' or (membership[3] and membership[3] ~= role) then
  return false
end
local organizationLeaseVersion = redis.call('GET', organizationLease) or '0'

if operation == 'register' then
  if storedIdentity then
    local lease = redis.call('HMGET', socket, 'membership', 'organizationLease')
    return lease[1] == membershipVersion and lease[2] == organizationLeaseVersion
  end
  redis.call('HSET', socket, 'identity', identity, 'membership', membershipVersion,
    'organizationLease', organizationLeaseVersion, 'deliveryChannel', deliveryChannel,
    'registration', requestId, 'resourceRooms', 0,
    'selection:organization', selector, 'room:' .. selector, 'selection:organization',
    'room:' .. room, 'personal')
  redis.call('PEXPIREAT', socket, expiresAt)
  if membership[1] then redis.call('PEXPIREAT', member, expiresAt, 'GT') end
  return 1
end
local registration = redis.call('HMGET', socket, 'membership', 'resourceRooms', 'organizationLease')
local resourceRooms = tonumber(registration[2])
if registration[1] ~= membershipVersion or registration[3] ~= organizationLeaseVersion
  or not resourceRooms then return false end

local epoch = redis.call('GET', visibility) or '0'
if operation == 'read' then return epoch end
if operation == 'has' then
  return epoch == expectedEpoch and redis.call('HEXISTS', socket, 'room:' .. room) == 1
end
if operation == 'publish' then
  if epoch ~= expectedEpoch or redis.call('HEXISTS', socket, 'room:' .. room) ~= 1 then
    return false
  end
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
    redis.call('HDEL', socket, selectionField, 'room:' .. previous)
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
