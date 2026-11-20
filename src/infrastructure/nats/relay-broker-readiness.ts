import { setTimeout as delay } from 'node:timers/promises';

const retryDelayMs = 250;
const advisoryPollMs = 1_000;
const advisoryProofLifetimeMs = 3_000;

/** Admits sockets while the relay broker has caught up and its failure stream is clear. */
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

  /** Monotone freshness bound for the last successful advisory read. */
  private clearUntil = 0;

  /** Closes transports even when a fresh broker read is still pending. */
  private freshnessTimer: ReturnType<typeof setTimeout> | undefined;

  /** The watcher starts once and cannot resume after application shutdown. */
  private lifecycle: 'initial' | 'watching' | 'stopped' = 'initial';

  /** Detaches the kit's availability watcher. */
  private unsubscribeAvailability: (() => void) | undefined;

  /** Whether the current broker cycle permits admission. */
  public get ready(): boolean {
    return this.caughtUp && performance.now() < this.clearUntil;
  }
  // #endregion

  // #region Constructor
  /** Uses the broker's availability feed and a single snapshot of required consumer counts. */
  public constructor(
    private readonly watchAvailability: (listener: (available: boolean) => void) => () => void,
    private readonly checkCaughtUp: (signal: AbortSignal) => Promise<boolean>,
    private readonly checkAdvisoryStream: (signal: AbortSignal) => Promise<boolean>,
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
        if (!this.checking) void this.pollBroker();
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
    if (cycle === undefined) return;
    cycle.abort();
    this.closeAdmission(true);
  }

  private closeAdmission(forceNotify = false): void {
    const wasOpen = this.caughtUp;
    this.caughtUp = false;
    this.clearUntil = 0;
    clearTimeout(this.freshnessTimer);
    this.freshnessTimer = undefined;
    if (!wasOpen && !forceNotify) return;
    for (const listener of this.unavailableListeners) {
      try {
        listener();
      } catch {
        // Give the other registered servers a chance to close their transports.
      }
    }
  }

  private openAdmission(clearUntil: number): void {
    this.caughtUp = true;
    this.clearUntil = clearUntil;
    clearTimeout(this.freshnessTimer);
    this.freshnessTimer = setTimeout(
      () => {
        this.closeAdmission();
      },
      Math.max(0, clearUntil - performance.now()),
    );
    this.freshnessTimer.unref();
  }

  /** Serializes probes and checks the durable error stream throughout the broker cycle. */
  private async pollBroker(): Promise<void> {
    this.checking = true;
    try {
      while (this.cycle !== undefined) {
        const { signal } = this.cycle;
        const wasOpen = this.ready;
        let clearUntil = 0;
        try {
          const current = wasOpen || (await this.checkCaughtUp(signal));
          if (current && !signal.aborted) {
            const proofDeadline = performance.now() + advisoryProofLifetimeMs;
            if (await this.checkAdvisoryStream(signal)) clearUntil = proofDeadline;
          }
        } catch {
          clearUntil = 0;
        }
        if (signal.aborted) continue;
        const receivedAt = performance.now();
        if (clearUntil > receivedAt && (!wasOpen || this.clearUntil > receivedAt)) {
          this.openAdmission(clearUntil);
        } else {
          this.closeAdmission();
        }
        const interval = this.ready ? advisoryPollMs : retryDelayMs;
        await delay(interval, undefined, { ref: false, signal }).catch(() => undefined);
      }
    } finally {
      this.checking = false;
    }
  }
  // #endregion
}
