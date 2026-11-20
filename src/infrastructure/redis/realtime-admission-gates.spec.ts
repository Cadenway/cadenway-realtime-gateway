import { describe, expect, it, vi } from 'vitest';

import { RealtimeAdmissionGates } from './realtime-admission-gates.js';

describe('Realtime admission gates', () => {
  it('opens only after the broker and both private subscriptions are ready', () => {
    const gates = new RealtimeAdmissionGates();
    const stopWatching = (): (() => void) => () => undefined;
    let ownerReady = false;

    expect(gates.ready).toBe(false);
    gates.track('broker-relays', () => true, stopWatching);
    gates.track('presence', () => true, stopWatching);
    gates.track('owner-inbox', () => ownerReady, stopWatching);
    expect(gates.ready).toBe(false);

    ownerReady = true;
    expect(gates.ready).toBe(true);
  });

  it('closes local transports synchronously when a required subscription drops or detaches', () => {
    const gates = new RealtimeAdmissionGates();
    const closeTransport = vi.fn();
    const stopWatching = vi.fn();
    let disconnect: (() => void) | undefined;
    let ready = true;

    gates.onUnavailable(closeTransport);
    const detach = gates.track(
      'presence',
      () => ready,
      (notify) => {
        disconnect = notify;
        return stopWatching;
      },
    );
    ready = false;
    disconnect?.();
    expect(closeTransport).toHaveBeenCalledTimes(1);

    detach();
    expect(stopWatching).toHaveBeenCalledTimes(1);
    expect(closeTransport).toHaveBeenCalledTimes(2);
  });
});
