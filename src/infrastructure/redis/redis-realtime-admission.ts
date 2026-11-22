import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

import type { Redis } from 'ioredis';

const windowMs = 10_000;
const maximumClusterAttempts = 240;
const maximumSourceAttempts = 24;
const maximumPendingAttempts = 64;
const admissionTimeoutMs = 500;

const reserveAttempt = `
local function belowLimit(key, limit)
  return tonumber(redis.call('GET', key) or '0') < limit
end
local function count(key)
  if redis.call('INCR', key) == 1 then redis.call('PEXPIRE', key, ARGV[1]) end
end
if not belowLimit(KEYS[1], ${String(maximumClusterAttempts)})
  or not belowLimit(KEYS[2], ${String(maximumSourceAttempts)}) then
  return 0
end
count(KEYS[1])
count(KEYS[2])
return 1
`;

/** Uses the nearest address appended by Traefik, the sole proxy hop on the private listener. */
function sourceNetwork(request: IncomingMessage): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  const nearest = chain?.slice(chain.lastIndexOf(',') + 1).trim();
  const address = nearest && isIP(nearest) !== 0 ? nearest : request.socket.remoteAddress;
  if (address === undefined) return null;
  const zoneFree = address.split('%', 1)[0] ?? '';
  if (isIP(zoneFree) === 4) return zoneFree;
  if (isIP(zoneFree) !== 6) return null;

  const canonical = new URL(`http://[${zoneFree}]`).hostname.slice(1, -1);
  if (canonical.startsWith('::ffff:')) {
    const bytes = Buffer.from(
      canonical
        .slice(7)
        .split(':')
        .map((part) => part.padStart(4, '0'))
        .join(''),
      'hex',
    );
    if (bytes.length === 4) return bytes.join('.');
  }
  const [left = '', right] = canonical.split('::');
  const leading = left === '' ? [] : left.split(':');
  if (right === undefined) return leading.slice(0, 4).join(':');
  const trailing = right === '' ? [] : right.split(':');
  return [...leading, ...Array<string>(8 - leading.length - trailing.length).fill('0'), ...trailing]
    .slice(0, 4)
    .join(':');
}

/** Bounds public transports before Engine.IO or Identity allocate connection state. */
export class RedisRealtimeAdmission {
  // #region Properties
  /** Number of Redis admission checks this replica has in flight. */
  private pending = 0;
  // #endregion

  // #region Constructor
  /** Keeps the shared non-queueing Redis command connection. */
  public constructor(private readonly redis: Pick<Redis, 'eval'>) {}
  // #endregion

  // #region Methods
  /** Acquires an expiring source and cluster budget without queueing an admission. */
  public async allow(request: IncomingMessage): Promise<boolean> {
    if (this.pending >= maximumPendingAttempts) return false;
    const network = sourceNetwork(request);
    if (network === null) return false;
    const addressKey = createHash('sha256').update(network).digest('hex');
    const arguments_ = [
      'realtime:admission:cluster',
      `realtime:admission:source:${addressKey}`,
      String(windowMs),
    ];
    this.pending += 1;
    let timeout: NodeJS.Timeout | undefined;
    const expire = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => {
        resolve(false);
      }, admissionTimeoutMs).unref();
    });
    const decision = this.redis
      .eval(reserveAttempt, 2, ...arguments_)
      .then(
        (reply) => reply === 1,
        () => false,
      )
      .finally(() => {
        this.pending -= 1;
      });
    try {
      return await Promise.race([expire, decision]);
    } finally {
      clearTimeout(timeout);
    }
  }
  // #endregion
}
