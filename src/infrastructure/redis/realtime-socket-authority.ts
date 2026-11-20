import { createHash } from 'node:crypto';

/** Redis namespace shared by connection registration and checks of its authority. */
export const socketRegistryPrefix: string = 'realtime:connection:';

interface VerifiedSocketIdentity {
  // #region Properties
  /** Verified session identity, version, effective deadline, tenant, member, account and role. */
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly expiresAt: number;
  readonly organizationId: string;
  readonly memberId: string;
  readonly userId: string;
  readonly role: string;
  // #endregion
}

/** Derives the registration key from a server-owned socket ID. */
export function socketRegistrationKey(socketId: string): string {
  return `${socketRegistryPrefix}socket:${encodeURIComponent(socketId)}`;
}

/** Derives the version and revocation marker key for one session. */
export function sessionKey(sessionId: string): string {
  return `${socketRegistryPrefix}session:${encodeURIComponent(sessionId.toLowerCase())}`;
}

/** Derives the version, role and removal marker key for one tenant membership. */
export function membershipKey(organizationId: string, memberId: string): string {
  return `${socketRegistryPrefix}member:${encodeURIComponent(organizationId.toLowerCase())}:${encodeURIComponent(memberId.toLowerCase())}`;
}

/** Derives the epoch key that fences all older tenant socket registrations. */
export function organizationLeaseKey(organizationId: string): string {
  return `${socketRegistryPrefix}organization-lease:${encodeURIComponent(organizationId.toLowerCase())}`;
}

/** Binds the Redis registration to the exact verified claims without hashing a bearer token. */
export function socketIdentityFingerprint(session: VerifiedSocketIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        session.sessionId,
        session.sessionVersion,
        session.expiresAt,
        session.organizationId,
        session.memberId,
        session.userId,
        session.role,
      ]),
    )
    .digest('hex');
}

/** Lua functions shared by scripts that validate or act on the same socket authority. */
export const socketAuthorityLua: string = `
local function readSocketAuthority(session, member, organizationLease, sessionVersion, role, expiresAt, now)
  if not expiresAt or expiresAt <= now or not sessionVersion or sessionVersion < 1 then
    return false
  end
  local sessionMarker = redis.call('HMGET', session, 'version', 'terminal')
  if sessionMarker[2] == '1' or tonumber(sessionMarker[1] or '0') > sessionVersion then
    return false
  end
  local membership = redis.call('HMGET', member, 'version', 'terminal', 'role')
  if membership[2] == '1' or (membership[3] and membership[3] ~= role) then
    return false
  end
  return membership, redis.call('GET', organizationLease) or '0'
end

local function currentSocketRegistration(socket, identity, membershipVersion, organizationLeaseVersion)
  local registration = redis.call('HMGET', socket, 'identity', 'membership', 'resourceRooms', 'organizationLease')
  if registration[1] ~= identity or registration[2] ~= membershipVersion
    or registration[4] ~= organizationLeaseVersion then
    return nil
  end
  return tonumber(registration[3])
end
`;
