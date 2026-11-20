import { describe, expect, it, vi } from 'vitest';

import { RelayBrokerReadiness } from './relay-broker-readiness.js';

function broker(
  available: boolean,
  checkCaughtUp: (signal: AbortSignal) => Promise<boolean>,
  checkAdvisory: (signal: AbortSignal) => Promise<boolean> = () => Promise.resolve(true),
) {
  let update: (available: boolean) => void = () => undefined;
  const unsubscribe = vi.fn();
  const gate = new RelayBrokerReadiness(
    (listener) => {
      update = listener;
      listener(available);
      return unsubscribe;
    },
    checkCaughtUp,
    checkAdvisory,
  );
  return {
    gate,
    change: (value: boolean): void => {
      update(value);
    },
    unsubscribe,
  };
}

function pendingSnapshot(): { promise: Promise<boolean>; resolve: (caughtUp: boolean) => void } {
  let resolve!: (caughtUp: boolean) => void;
  const promise = new Promise<boolean>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('RelayBrokerReadiness', () => {
  it('opens only after catch-up and closes synchronously on loss of broker health', async () => {
    const caughtUp = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const { gate, change } = broker(false, caughtUp);
    const close = vi.fn(() => gate.ready);
    gate.onUnavailable(close);
    gate.onApplicationBootstrap();

    expect(gate.ready).toBe(false);
    expect(caughtUp).not.toHaveBeenCalled();

    change(true);
    expect(gate.ready).toBe(false);
    await vi.waitFor(() => {
      expect(gate.ready).toBe(true);
    });
    change(true);
    expect(caughtUp).toHaveBeenCalledTimes(1);

    change(false);
    expect(gate.ready).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveReturnedWith(false);
    change(false);
    expect(close).toHaveBeenCalledTimes(1);
    gate.beforeApplicationShutdown();
  });

  it('rejects a superseded positive snapshot and holds one broker check in flight', async () => {
    const previous = pendingSnapshot();
    const current = pendingSnapshot();
    const check = vi
      .fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    const { gate, change } = broker(true, check);
    const close = vi.fn();
    gate.onUnavailable(close);
    gate.onApplicationBootstrap();

    change(false);
    expect(check.mock.calls[0]?.[0].aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    change(true);
    expect(check).toHaveBeenCalledTimes(1);

    previous.resolve(true);
    await vi.waitFor(() => {
      expect(check).toHaveBeenCalledTimes(2);
    });
    expect(gate.ready).toBe(false);
    expect(check.mock.calls[1]?.[0].aborted).toBe(false);

    current.resolve(true);
    await vi.waitFor(() => {
      expect(gate.ready).toBe(true);
    });
    gate.beforeApplicationShutdown();
  });

  it('keeps polling through both a failed check and a remaining backlog', async () => {
    const check = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('Broker query failed.'))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { gate } = broker(true, check);
    gate.onApplicationBootstrap();
    expect(gate.ready).toBe(false);

    await vi.waitFor(
      () => {
        expect(gate.ready).toBe(true);
      },
      { timeout: 2000 },
    );
    expect(check).toHaveBeenCalledTimes(3);
    gate.beforeApplicationShutdown();
  });

  it('closes existing sockets on a retained advisory and checks backlog before reopening', async () => {
    const caughtUp = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const advisory = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const { gate } = broker(true, caughtUp, advisory);
    const close = vi.fn();
    gate.onUnavailable(close);
    gate.onApplicationBootstrap();
    try {
      await vi.waitFor(() => {
        expect(gate.ready).toBe(true);
      });
      advisory.mockResolvedValue(false);
      await vi.waitFor(
        () => {
          expect(gate.ready).toBe(false);
        },
        { timeout: 1_500 },
      );
      expect(close).toHaveBeenCalledOnce();

      caughtUp.mockResolvedValue(false);
      advisory.mockResolvedValue(true);
      await vi.waitFor(() => {
        expect(caughtUp).toHaveBeenCalledTimes(2);
      });
      expect(gate.ready).toBe(false);

      caughtUp.mockResolvedValue(true);
      await vi.waitFor(() => {
        expect(gate.ready).toBe(true);
      });
    } finally {
      gate.beforeApplicationShutdown();
    }
  });

  it('closes transports if the next advisory probe has not refreshed the current proof', async () => {
    const pending = pendingSnapshot();
    const advisory = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(false);
    const caughtUp = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const { gate } = broker(true, caughtUp, advisory);
    const close = vi.fn();
    gate.onUnavailable(close);
    gate.onApplicationBootstrap();
    try {
      await vi.waitFor(() => {
        expect(gate.ready).toBe(true);
      });
      await vi.waitFor(
        () => {
          expect(advisory).toHaveBeenCalledTimes(2);
        },
        { timeout: 1_500 },
      );
      expect(caughtUp).toHaveBeenCalledOnce();

      await vi.waitFor(
        () => {
          expect(close).toHaveBeenCalledOnce();
        },
        { timeout: 3_500 },
      );
      expect(gate.ready).toBe(false);

      pending.resolve(true);
      await pending.promise;
      expect(gate.ready).toBe(false);
    } finally {
      pending.resolve(false);
      gate.beforeApplicationShutdown();
    }
  });

  it('does not open from an initially clear broker response received after its proof expired', async () => {
    vi.useFakeTimers();
    const pending = pendingSnapshot();
    const advisory = vi.fn<() => Promise<boolean>>().mockReturnValue(pending.promise);
    const { gate } = broker(true, () => Promise.resolve(true), advisory);
    gate.onApplicationBootstrap();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(advisory).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3_001);
      pending.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(gate.ready).toBe(false);
    } finally {
      pending.resolve(false);
      gate.beforeApplicationShutdown();
      vi.useRealTimers();
    }
  });

  it('aborts outstanding work and ignores stale watcher callbacks after shutdown', async () => {
    const snapshot = pendingSnapshot();
    const check = vi
      .fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockReturnValue(snapshot.promise);
    const { gate, change, unsubscribe } = broker(true, check);
    const close = vi.fn();
    const remove = gate.onUnavailable(close);
    remove();
    const closeRemaining = vi.fn();
    gate.onUnavailable(closeRemaining);
    gate.onApplicationBootstrap();
    gate.onApplicationBootstrap();

    gate.beforeApplicationShutdown();
    expect(check.mock.calls[0]?.[0].aborted).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(closeRemaining).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(gate.ready).toBe(false);

    snapshot.resolve(true);
    await snapshot.promise;
    change(true);
    gate.onApplicationBootstrap();
    expect(gate.ready).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    gate.beforeApplicationShutdown();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
