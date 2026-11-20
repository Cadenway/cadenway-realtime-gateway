import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ManagePresence } from '../../../../application/use-cases/commands/presence/manage-presence/manage-presence.use-case.js';
import { ExpirePresenceHandler } from './expire-presence.handler.js';

afterEach(() => vi.useRealTimers());

describe('ExpirePresenceHandler', () => {
  it('drains bounded full pages, waits for a partial page and stops on shutdown', async () => {
    vi.useFakeTimers();
    const expire = vi
      .fn<ManagePresence['expire']>()
      .mockResolvedValueOnce(500)
      .mockResolvedValue(0);
    const handler = new ExpirePresenceHandler({ expire } as unknown as ManagePresence);
    handler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(1);
    expect(expire).toHaveBeenCalledTimes(2);
    expect(expire).toHaveBeenCalledWith(500);
    await vi.advanceTimersByTimeAsync(4999);
    expect(expire).toHaveBeenCalledTimes(2);
    handler.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(5000);
    expect(expire).toHaveBeenCalledTimes(2);
  });
});
