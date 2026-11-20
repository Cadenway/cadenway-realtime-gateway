import { setTimeout as delay } from 'node:timers/promises';

const retryDelayMs = 250;

/** Admits sockets after the current broker connection has caught up on relay deliveries. */
export class RelayBrokerReadiness {
  // #region Properties
  /** Local close callbacks for Socket.IO servers. */
  private readonly unavailableListeners = new Set<() => void>();

  /** An availability cycle lasts until the broker or a required consumer becomes unhealthy. */
  private cycle: AbortController | undefined;

  /** Only one catch-up check may run, including checks from superseded cycles. */
  private checking = false;

  /** Whether the current availability cycle has caught up. */
  private caughtUp = false;

  /** The watcher starts once and cannot resume after application shutdown. */
  private lifecycle: 'initial' | 'watching' | 'stopped' = 'initial';

  /** Detaches the kit's availability watcher. */
  private unsubscribeAvailability: (() => void) | undefined;

  /** Whether the current broker cycle permits admission. */
  public get ready(): boolean {
    return this.caughtUp;
  }
  // #endregion

  // #region Constructor
  /** Uses the broker's availability feed and a single snapshot of required consumer counts. */
  public constructor(
    private readonly watchAvailability: (listener: (available: boolean) => void) => () => void,
    private readonly checkCaughtUp: (signal: AbortSignal) => Promise<boolean>,
  ) {}
  // #endregion

  // #region Methods
  /** Registers a callback that closes transports on the next loss of broker availability. */
  public onUnavailable(listener: () => void): () => void {
    this.unavailableListeners.add(listener);
    return () => {
      this.unavailableListeners.delete(listener);
    };
  }

  /** Starts watching the broker while admission remains closed. */
  public onApplicationBootstrap(): void {
    if (this.lifecycle !== 'initial') return;
    this.lifecycle = 'watching';
    this.unsubscribeAvailability = this.watchAvailability((available) => {
      if (this.lifecycle !== 'watching') return;
      if (!available) {
        this.closeCycle();
      } else if (this.cycle === undefined) {
        this.cycle = new AbortController();
        if (!this.checking) void this.awaitCatchUp();
      }
    });
  }

  /** Stops admissions, closes transports and detaches the broker watcher. */
  public beforeApplicationShutdown(): void {
    this.lifecycle = 'stopped';
    this.closeCycle();
    this.unsubscribeAvailability?.();
    this.unsubscribeAvailability = undefined;
    this.unavailableListeners.clear();
  }

  /** Invalidates the current check before closing transports synchronously. */
  private closeCycle(): void {
    const cycle = this.cycle;
    this.cycle = undefined;
    this.caughtUp = false;
    if (cycle === undefined) return;
    cycle.abort();
    for (const listener of this.unavailableListeners) {
      try {
        listener();
      } catch {
        // Give the other registered servers a chance to close their transports.
      }
    }
  }

  /** Serializes checks and delays retries without keeping the process alive. */
  private async awaitCatchUp(): Promise<void> {
    this.checking = true;
    try {
      while (this.cycle !== undefined) {
        const { signal } = this.cycle;
        let caughtUp: boolean;
        try {
          caughtUp = await this.checkCaughtUp(signal);
        } catch {
          caughtUp = false;
        }
        if (signal.aborted) continue;
        if (caughtUp) {
          this.caughtUp = true;
          return;
        }
        await delay(retryDelayMs, undefined, { ref: false, signal }).catch(() => undefined);
      }
    } finally {
      this.checking = false;
    }
  }
  // #endregion
}
