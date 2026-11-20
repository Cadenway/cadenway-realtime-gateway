import { describe, expect, it, vi } from 'vitest';

import type { RealtimeSession } from '../../../../application/models/connection/realtime-session.model.js';
import { RedisSocketRegistry } from './redis-socket-registry.adapter.js';
import { socketRoomLimitReply } from './redis-socket-registry.scripts.js';

const identity: RealtimeSession = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  memberId: '00000000-0000-4000-8000-000000000002',
  userId: '00000000-0000-4000-8000-000000000003',
  sessionId: '00000000-0000-4000-8000-000000000004',
  sessionVersion: 1,
  role: 'member',
  expiresAt: 1_795_193_000_000,
};

describe('Redis socket registry command failures', () => {
  it('loads the script on Redis cache loss and keeps the exact lease command arguments', async () => {
    const evalsha = vi.fn().mockRejectedValue(new Error('NOSCRIPT No matching script.'));
    const evaluate = vi.fn().mockResolvedValue(1);
    const registry = new RedisSocketRegistry({ eval: evaluate, evalsha, incr: vi.fn() });

    expect(await registry.register('same-socket', identity)).toBe(true);
    expect(evalsha).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.slice(1)).toEqual(evalsha.mock.calls[0]?.slice(1));
  });

  it('distinguishes capacity from a stale fence and an accepted registration', async () => {
    const evalsha = vi
      .fn()
      .mockResolvedValueOnce(socketRoomLimitReply)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('');
    const registry = new RedisSocketRegistry({ eval: vi.fn(), evalsha, incr: vi.fn() });
    const join = () =>
      registry.join('same-socket', identity, '7', { kind: 'task', taskKey: 'CAD-482' }, 'task:abc');

    await expect(join()).resolves.toEqual({ kind: 'room-limit' });
    await expect(join()).resolves.toBeNull();
    await expect(join()).resolves.toEqual({ kind: 'joined', previousRoom: null });
  });

  it('fails closed with a redacted error and does not retry when Redis is unavailable', async () => {
    const rejected = new Error('Connection failed with a private Redis value.');
    const evalsha = vi.fn().mockRejectedValue(rejected);
    const evaluate = vi.fn();
    const registry = new RedisSocketRegistry({
      eval: evaluate,
      evalsha,
      incr: vi.fn().mockRejectedValue(rejected),
    });

    await expect(registry.register('same-socket', identity)).rejects.toThrow(
      /^Redis socket registry is unavailable\.$/u,
    );
    await expect(registry.readFence('same-socket', identity)).rejects.toThrow(
      /^Redis socket registry is unavailable\.$/u,
    );
    await expect(registry.markSessionRevoked(identity.sessionId, 2)).rejects.toThrow(
      /^Redis socket registry is unavailable\.$/u,
    );
    await expect(registry.advanceVisibility(identity.organizationId)).rejects.toThrow(
      /^Redis socket registry is unavailable\.$/u,
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
});
