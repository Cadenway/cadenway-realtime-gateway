import { EventEmitter } from 'node:events';

import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { RedisPresenceSubscription } from './redis-presence-subscription.adapter.js';

const organizationId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const memberId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f17';
const id = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f18';
const at = '2026-11-20T18:00:00Z';
type Deliver = ConstructorParameters<typeof RedisPresenceSubscription>[1];

function fixture(
  deliver: Deliver = vi.fn<Deliver>().mockResolvedValue(undefined),
  acknowledge = vi.fn<() => Promise<number>>().mockResolvedValue(1),
) {
  const subscriber = Object.assign(new EventEmitter(), {
    status: 'ready',
    psubscribe: acknowledge,
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
  });
  const command = Object.assign(new EventEmitter(), {
    status: 'ready',
    duplicate: vi.fn(() => subscriber),
  });
  const subscription = new RedisPresenceSubscription(
    command as unknown as Redis,
    deliver,
    () => () => undefined,
  );
  return { subscriber, subscription, acknowledge };
}

function publish(subscriber: EventEmitter, status: string): void {
  subscriber.emit(
    'pmessage',
    'realtime:presence:org:*',
    `realtime:presence:org:${organizationId}`,
    JSON.stringify({ id, at, memberId, status }),
  );
}

describe('RedisPresenceSubscription', () => {
  it('delivers only valid organization transitions after subscription acknowledgement', async () => {
    const deliver = vi.fn<Deliver>().mockResolvedValue(undefined);
    const { subscriber, subscription } = fixture(deliver);
    const unavailable = vi.fn();
    subscription.onUnavailable(unavailable);
    await vi.waitFor(() => {
      expect(subscription.ready).toBe(true);
    });

    const payload = JSON.stringify({ id, at, memberId, status: 'away' });
    publish(subscriber, 'away');
    subscriber.emit('pmessage', 'realtime:presence:org:*', 'realtime:presence:org:bad', payload);
    subscriber.emit(
      'pmessage',
      'realtime:presence:org:*',
      `realtime:presence:org:${organizationId}`,
      '{bad',
    );
    publish(subscriber, 'invisible');
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      organizationId,
      { id, type: 'user.status-changed.v1', at, version: 1, data: { memberId, status: 'away' } },
      expect.any(Function),
    );

    subscriber.emit('close');
    expect(subscription.ready).toBe(false);
    expect(unavailable).toHaveBeenCalledTimes(1);
    publish(subscriber, 'away');
    expect(deliver).toHaveBeenCalledTimes(1);
    subscriber.emit('ready');
    await vi.waitFor(() => {
      expect(subscription.ready).toBe(true);
    });
    await subscription.onApplicationShutdown();
    expect(subscription.ready).toBe(false);
  });

  it('recovers after a rejection without reconnecting and cancels later retry on shutdown', async () => {
    const acknowledge = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    acknowledge.mockRejectedValueOnce(new Error('Temporary subscription failure.'));
    vi.useFakeTimers();
    const { subscriber, subscription } = fixture(undefined, acknowledge);
    try {
      expect(subscription.ready).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(acknowledge).toHaveBeenCalledTimes(2);
      expect(subscription.ready).toBe(true);

      subscriber.emit('close');
      acknowledge.mockRejectedValueOnce(new Error('Temporary subscription failure.'));
      subscriber.emit('ready');
      await vi.advanceTimersByTimeAsync(0);
      await subscription.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(acknowledge).toHaveBeenCalledTimes(3);
      expect(subscription.ready).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supersedes an in-progress online delivery with the offline transition for the same member', async () => {
    let releaseDelivery!: () => void;
    const delayed = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const received: unknown[] = [];
    const deliver = vi
      .fn<Deliver>()
      .mockImplementationOnce(async (_organizationId, packet, stillCurrent) => {
        await delayed;
        if (stillCurrent()) received.push(packet);
      })
      .mockImplementation((_organizationId, packet, stillCurrent) => {
        if (stillCurrent()) received.push(packet);
        return Promise.resolve();
      });
    const { subscriber, subscription } = fixture(deliver);
    try {
      await vi.waitFor(() => {
        expect(subscription.ready).toBe(true);
      });
      publish(subscriber, 'online');
      publish(subscriber, 'offline');
      releaseDelivery();
      await delayed;

      expect(received).toEqual([
        {
          id,
          type: 'user.status-changed.v1',
          at,
          version: 1,
          data: { memberId, status: 'offline' },
        },
      ]);
    } finally {
      await subscription.onApplicationShutdown();
    }
  });
});
