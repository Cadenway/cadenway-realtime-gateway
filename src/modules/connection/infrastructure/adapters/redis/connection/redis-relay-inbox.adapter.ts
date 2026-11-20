import { pubSubClientOptions, ResilientRedisClient } from '@cadenway/nest-common/redis';
import type { OnApplicationShutdown } from '@nestjs/common';

import type { RealtimeAdmissionGates } from '../../../../../../infrastructure/redis/realtime-admission-gates.js';
import { RedisSubscriptionRecovery } from '../../../../../../infrastructure/redis/redis-subscription-recovery.js';

const lostEvents = ['close', 'reconnecting', 'end'] as const;
const maximumConcurrentHandoffs = 128;

/** Receives notices only after Redis acknowledged this replica's private delivery channel. */
export class RedisRelayInbox implements OnApplicationShutdown {
  // #region Properties
  /** Dedicated subscriber, independent of the Socket.IO adapter's indexes and control traffic. */
  private readonly subscriber: ResilientRedisClient;

  /** Gate callback for Socket.IO admission and health checks. */
  private readonly untrack: () => void;

  /** Recovers the exact subscription after transient failures or reconnects. */
  private readonly subscription: RedisSubscriptionRecovery;

  /** Bounds checks for waiting local transports under burst load. */
  private pending = 0;

  /** Availability watchers own transports that must close when the subscription is lost. */
  private readonly unavailableListeners = new Set<() => void>();

  /** The command connection has received a fresh subscription acknowledgement. */
  public get available(): boolean {
    return this.subscription.ready && this.subscriber.status === 'ready';
  }
  // #endregion

  // #region Constructor
  /** Opens an acknowledgement-tracked inbox for one owner without replaying lost messages. */
  public constructor(
    command: ResilientRedisClient,
    private readonly channel: string,
    private readonly receive: (payload: string) => Promise<void>,
    gates: RealtimeAdmissionGates,
  ) {
    this.subscriber = new ResilientRedisClient({
      ...pubSubClientOptions(command.options, 'subscriber'),
      connectionName: 'realtime-gateway-owner-inbox',
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: false,
      maxRetriesPerRequest: 0,
    });
    this.subscription = new RedisSubscriptionRecovery(
      () => this.subscriber.status === 'ready',
      async () => (await this.subscriber.subscribe(this.channel)) === 1,
    );
    this.untrack = gates.track(
      'owner-inbox',
      () => this.available,
      (listener) => this.onUnavailable(listener),
    );
    this.subscriber.on('ready', this.onReady);
    this.subscriber.on('message', this.onMessage);
    for (const event of lostEvents) this.subscriber.on(event, this.onLost);
    this.subscription.resume();
  }
  // #endregion

  // #region Properties
  /** Restores the private route only after Redis accepts the subscription again. */
  private readonly onReady = (): void => {
    this.subscription.resume();
  };

  /** Invalidates old acknowledgements and tells transport owners to close existing sockets. */
  private readonly onLost = (): void => {
    const wasSubscribed = this.subscription.ready;
    this.subscription.invalidate();
    if (wasSubscribed) for (const listener of this.unavailableListeners) listener();
  };

  /** An overflowing socket receives no old data; the browser refetches on reconnection. */
  private readonly onMessage = (channel: string, payload: string): void => {
    if (!this.available || channel !== this.channel || this.pending >= maximumConcurrentHandoffs)
      return;
    this.pending += 1;
    void this.receive(payload)
      .catch(() => undefined)
      .finally(() => {
        this.pending -= 1;
      });
  };
  // #endregion

  // #region Methods
  /** Registers the listener for loss of this acknowledged private route. */
  public onUnavailable(listener: () => void): () => void {
    this.unavailableListeners.add(listener);
    return () => {
      this.unavailableListeners.delete(listener);
    };
  }

  /** Closes the private route and detaches all listeners. */
  public async onApplicationShutdown(): Promise<void> {
    this.onLost();
    this.subscription.stop();
    this.untrack();
    this.subscriber.off('ready', this.onReady);
    this.subscriber.off('message', this.onMessage);
    for (const event of lostEvents) this.subscriber.off(event, this.onLost);
    this.unavailableListeners.clear();
    await this.subscriber.shutDown();
  }
  // #endregion
}
