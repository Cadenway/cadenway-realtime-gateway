const initialRetryDelayMs = 100;
const maximumRetryDelayMs = 5_000;

/** Restores one set of Redis subscriptions, retrying only while its connection can subscribe. */
export class RedisSubscriptionRecovery {
  // #region Properties
  /** Fences acknowledgements and scheduled retries after loss or configuration changes. */
  private generation = 0;
  private acknowledgement = false;
  private running = false;
  private stopped = false;
  private retry: NodeJS.Timeout | undefined;
  private retryDelayMs = initialRetryDelayMs;

  /** Whether Redis acknowledged the current subscription generation. */
  public get ready(): boolean {
    return this.acknowledgement;
  }
  // #endregion

  // #region Constructor
  /** Binds the connection check and one acknowledgement attempt. */
  public constructor(
    private readonly canSubscribe: () => boolean,
    private readonly subscribe: () => Promise<boolean>,
  ) {}
  // #endregion

  // #region Methods
  /** Starts an attempt on readiness without duplicating one already running or scheduled. */
  public resume(): void {
    if (
      this.stopped ||
      this.running ||
      this.retry !== undefined ||
      this.acknowledgement ||
      !this.canSubscribe()
    )
      return;
    this.running = true;
    void this.restore(this.generation);
  }

  /** Discards an obsolete acknowledgement and cancels the matching retry. */
  public invalidate(): void {
    this.generation += 1;
    this.acknowledgement = false;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
    this.retryDelayMs = initialRetryDelayMs;
  }

  /** Permanently disables recovery and prevents in-flight work from reopening admission. */
  public stop(): void {
    this.stopped = true;
    this.invalidate();
  }

  /** Serializes attempts across reconnects and only accepts an acknowledgement from its owner. */
  private async restore(generation: number): Promise<void> {
    let acknowledged = false;
    try {
      acknowledged = await this.subscribe();
    } catch {
      // The connection owns diagnostics; admission stays closed during a retry.
    }
    this.running = false;
    if (generation !== this.generation) {
      this.resume();
      return;
    }
    if (!this.canSubscribe()) return;
    if (acknowledged) {
      this.acknowledgement = true;
      return;
    }
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.resume();
    }, this.retryDelayMs).unref();
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, maximumRetryDelayMs);
  }
  // #endregion
}
