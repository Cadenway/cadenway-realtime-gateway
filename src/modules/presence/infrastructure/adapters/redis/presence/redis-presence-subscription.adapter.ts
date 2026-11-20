import type { Redis } from 'ioredis';
import { z } from 'zod';

import { RedisSubscriptionRecovery } from '../../../../../../infrastructure/redis/redis-subscription-recovery.js';

const pattern = 'realtime:presence:org:*';
const channelPattern = /^realtime:presence:org:([0-9a-f-]{36})$/u;
const messageSchema = z.strictObject({
  id: z.uuid(),
  at: z.iso.datetime(),
  memberId: z.uuid(),
  status: z.enum(['online', 'away', 'do-not-disturb', 'offline']),
});

/** Receives committed visible transitions for local, already-authorized sockets. */
export class RedisPresenceSubscription {
  // #region Properties
  /** Dedicated connection and acknowledgement recovery for this replica. */
  private readonly subscriber: Redis;
  private readonly subscription: RedisSubscriptionRecovery;

  /** Tracks only deliveries in progress; a newer transition supersedes the old one. */
  private readonly deliveries = new Map<string, symbol>();
  private readonly unavailable = new Set<() => void>();
  private readonly untrack: () => void;

  /** True after Redis has acknowledged the subscription in its current connection. */
  public get ready(): boolean {
    return (
      this.command.status === 'ready' &&
      this.subscriber.status === 'ready' &&
      this.subscription.ready
    );
  }
  // #endregion

  // #region Constructor
  /** Uses a dedicated subscription connection and an explicitly local delivery callback. */
  public constructor(
    private readonly command: Redis,
    private readonly deliver: (
      organizationId: string,
      packet: unknown,
      stillCurrent: () => boolean,
    ) => Promise<void>,
    register: (
      check: () => boolean,
      onUnavailable: (listener: () => void) => () => void,
    ) => () => void,
  ) {
    this.subscriber = command.duplicate({
      connectionName: 'realtime-gateway-presence',
      enableOfflineQueue: false,
      autoResubscribe: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
    });
    this.subscription = new RedisSubscriptionRecovery(
      () => this.command.status === 'ready' && this.subscriber.status === 'ready',
      async () => (await this.subscriber.psubscribe(pattern)) === 1,
    );
    this.subscriber.on('error', () => undefined);
    this.command.on('close', this.lost);
    this.command.on('ready', this.subscribe);
    this.subscriber.on('close', this.lost);
    this.subscriber.on('ready', this.subscribe);
    this.subscriber.on('pmessage', this.receive);
    this.untrack = register(
      () => this.ready,
      (listener) => this.onUnavailable(listener),
    );
    this.subscription.resume();
  }
  // #endregion

  // #region Methods
  /** Registers a synchronous callback for loss of the subscription. */
  public onUnavailable(listener: () => void): () => void {
    this.unavailable.add(listener);
    return () => {
      this.unavailable.delete(listener);
    };
  }

  /** Closes the dedicated connection and removes listeners at shutdown. */
  public async onApplicationShutdown(): Promise<void> {
    this.lost();
    this.subscription.stop();
    this.untrack();
    this.command.off('close', this.lost);
    this.command.off('ready', this.subscribe);
    this.subscriber.off('close', this.lost);
    this.subscriber.off('ready', this.subscribe);
    this.subscriber.off('pmessage', this.receive);
    if (this.subscriber.status === 'ready') await this.subscriber.quit();
    else this.subscriber.disconnect();
  }
  // #endregion

  // #region Properties
  /** Invalidates pending acknowledgements on Redis connection loss. */
  private readonly lost = (): void => {
    const wasSubscribed = this.subscription.ready;
    this.subscription.invalidate();
    this.deliveries.clear();
    if (wasSubscribed) for (const listener of this.unavailable) listener();
  };

  /** Restores the exact subscription after reconnecting. */
  private readonly subscribe = (): void => {
    this.subscription.resume();
  };

  /** Validates the organization and committed transition before local delivery. */
  private readonly receive = (_pattern: string, channel: string, payload: string): void => {
    if (!this.ready) return;
    const match = channelPattern.exec(channel);
    const organizationId = z.uuid().safeParse(match?.[1]);
    if (!organizationId.success) return;
    let raw: unknown;
    try {
      raw = JSON.parse(payload) as unknown;
    } catch {
      return;
    }
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) return;
    const { id, at, memberId, status } = parsed.data;
    const memberKey = `${organizationId.data}/${memberId.toLowerCase()}`;
    const delivery = Symbol();
    this.deliveries.set(memberKey, delivery);
    const stillCurrent = (): boolean => this.ready && this.deliveries.get(memberKey) === delivery;
    void this.deliver(
      organizationId.data,
      { id, type: 'user.status-changed.v1', at, version: 1, data: { memberId, status } },
      stillCurrent,
    )
      .catch(() => undefined)
      .finally(() => {
        if (this.deliveries.get(memberKey) === delivery) this.deliveries.delete(memberKey);
      });
  };
  // #endregion
}
