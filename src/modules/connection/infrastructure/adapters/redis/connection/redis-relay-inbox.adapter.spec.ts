import type { ResilientRedisClient } from '@cadenway/nest-common/redis';
import { describe, expect, it, vi } from 'vitest';

import { RealtimeAdmissionGates } from '../../../../../../infrastructure/redis/realtime-admission-gates.js';
import { RedisRelayInbox } from './redis-relay-inbox.adapter.js';

const adapter = vi.hoisted(() => ({
  subscribe: vi.fn<() => Promise<unknown>>(),
  shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  listeners: new Map<string, (...arguments_: never[]) => void>(),
  status: 'ready',
}));

vi.mock('@cadenway/nest-common/redis', () => ({
  pubSubClientOptions: () => ({}),
  ResilientRedisClient: class {
    public get status() {
      return adapter.status;
    }

    public subscribe() {
      return adapter.subscribe();
    }

    public on(event: string, handler: (...arguments_: never[]) => void) {
      adapter.listeners.set(event, handler);
    }

    public off(event: string) {
      adapter.listeners.delete(event);
    }

    public async shutDown() {
      await adapter.shutdown();
    }
  },
}));

function emit(event: string, ...arguments_: string[]): void {
  const listener = adapter.listeners.get(event) as ((...arguments_: string[]) => void) | undefined;
  listener?.(...arguments_);
}

function deferredAcknowledgement(): {
  readonly promise: Promise<number>;
  readonly resolve: (count: number) => void;
} {
  let fulfill: (count: number) => void = () => {
    throw new Error('Acknowledgement promise has not initialized.');
  };
  const promise = new Promise<number>((resolve) => {
    fulfill = resolve;
  });
  return { promise, resolve: fulfill };
}

describe('owner relay inbox readiness', () => {
  it('accepts only the current exact subscription and closes readiness synchronously on loss', async () => {
    const first = deferredAcknowledgement();
    const last = deferredAcknowledgement();
    adapter.subscribe.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const receive = vi.fn<(payload: string) => Promise<void>>().mockResolvedValue(undefined);
    const onUnavailable = vi.fn();
    const source = { options: {} } as unknown as ResilientRedisClient;
    const inbox = new RedisRelayInbox(
      source,
      'private-test-channel',
      receive,
      new RealtimeAdmissionGates(),
    );
    inbox.onUnavailable(onUnavailable);
    try {
      emit('ready');
      expect(inbox.available).toBe(false);
      emit('close');
      emit('ready');
      first.resolve(1);
      await Promise.resolve();
      expect(inbox.available).toBe(false);

      last.resolve(1);
      await Promise.resolve();
      expect(inbox.available).toBe(true);
      emit('message', 'another-channel', '{}');
      emit('message', 'private-test-channel', '{}');
      expect(receive).toHaveBeenCalledExactlyOnceWith('{}');

      emit('reconnecting');
      expect(inbox.available).toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
      emit('message', 'private-test-channel', '{}');
      expect(receive).toHaveBeenCalledOnce();
    } finally {
      await inbox.onApplicationShutdown();
    }
    expect(adapter.shutdown).toHaveBeenCalledOnce();
  });
});
