import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';

import type { ManagePresence } from '../../../../application/use-cases/commands/presence/manage-presence/manage-presence.use-case.js';

/** Reconciles a bounded page of expired member leases without overlapping sweeps. */
export class ExpirePresenceHandler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  // #region Properties
  /** Timer and lifecycle state for the single sweep loop. */
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  // #endregion

  // #region Constructor
  /** Binds the shared lease reconciliation operation. */
  public constructor(private readonly presence: ManagePresence) {}
  // #endregion

  // #region Methods
  /** Begins periodic bounded expiry work. */
  public onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /** Stops scheduling new sweeps during shutdown. */
  public beforeApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.presence.expire(500).then(
        (count) => {
          this.schedule(count === 500 ? 0 : 5_000);
        },
        () => {
          this.schedule(5_000);
        },
      );
    }, delay);
    this.timer.unref();
  }
  // #endregion
}
