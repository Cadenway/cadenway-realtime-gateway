import { EventEmitter } from 'node:events';

import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { RedisPresenceSubscription } from './redis-presence-subscription.adapter.js';

const organizationId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const memberId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f17';
const id = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f18';

describe('RedisPresenceSubscription', () => {
  it('delivers only valid organization transitions after subscription acknowledgement', async () => {
    const subscriber = Object.assign(new EventEmitter(), {
      status: 'ready',
      psubscribe: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue('OK'),
      disconnect: vi.fn(),
    });
    const command = Object.assign(new EventEmitter(), {
      status: 'ready',
      duplicate: vi.fn(() => subscriber),
    });
    const deliver = vi
      .fn<(_organizationId: string, _packet: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);
    const subscription = new RedisPresenceSubscription(
      command as unknown as Redis,
      deliver,
      () => () => undefined,
    );
    const unavailable = vi.fn();
    subscription.onUnavailable(unavailable);
    await Promise.resolve();
    expect(subscription.ready).toBe(true);

    const payload = JSON.stringify({ id, at: '2026-11-20T18:00:00Z', memberId, status: 'away' });
    subscriber.emit(
      'pmessage',
      'realtime:presence:org:*',
      `realtime:presence:org:${organizationId}`,
      payload,
    );
    subscriber.emit('pmessage', 'realtime:presence:org:*', 'realtime:presence:org:bad', payload);
    subscriber.emit(
      'pmessage',
      'realtime:presence:org:*',
      `realtime:presence:org:${organizationId}`,
      '{bad',
    );
    subscriber.emit(
      'pmessage',
      'realtime:presence:org:*',
      `realtime:presence:org:${organizationId}`,
      JSON.stringify({ id, at: '2026-11-20T18:00:00Z', memberId, status: 'invisible' }),
    );
    expect(deliver).toHaveBeenCalledExactlyOnceWith(organizationId, {
      id,
      type: 'user.status-changed.v1',
      at: '2026-11-20T18:00:00Z',
      version: 1,
      data: { memberId, status: 'away' },
    });

    subscriber.emit('close');
    expect(subscription.ready).toBe(false);
    expect(unavailable).toHaveBeenCalledTimes(1);
    subscriber.emit(
      'pmessage',
      'realtime:presence:org:*',
      `realtime:presence:org:${organizationId}`,
      payload,
    );
    expect(deliver).toHaveBeenCalledTimes(1);
    subscriber.emit('ready');
    await Promise.resolve();
    expect(subscription.ready).toBe(true);
    await subscription.onApplicationShutdown();
    expect(subscription.ready).toBe(false);
  });
});
