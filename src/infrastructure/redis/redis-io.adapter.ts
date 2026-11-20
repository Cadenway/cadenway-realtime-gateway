import type { IncomingMessage } from 'node:http';

import { pubSubClientOptions, ResilientRedisClient } from '@cadenway/nest-common/redis';
import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server, ServerOptions, Socket } from 'socket.io';

import type { RealtimeAdmissionGates } from './realtime-admission-gates.js';

const refusedOrigin = 'Origin not allowed';
const unavailable = 'Realtime unavailable';
const lostEvents = ['close', 'reconnecting', 'end'] as const;

/** Combines Redis fan-out readiness for the servers owned by one application. */
export class SocketIoRedisReadiness {
  // #region Properties
  /** Readiness of each registered server. */
  private readonly checks = new Set<() => boolean>();
  // #endregion

  // #region Methods
  /** Registers one server and returns its disposal callback. */
  public track(check: () => boolean): () => void {
    this.checks.add(check);
    return () => {
      this.checks.delete(check);
    };
  }

  /** Reports an outage even if the command connection still answers PING. */
  public assertAvailable(): void {
    if (this.checks.size === 0 || ![...this.checks].every((check) => check())) {
      throw new Error(unavailable);
    }
  }
  // #endregion
}

/** Installs a Redis fan-out adapter and admits a fresh connection only while Redis is available. */
export class RedisIoAdapter extends IoAdapter {
  // #region Properties
  /** Exact browser origins for both transports. */
  private readonly allowedOrigins: ReadonlySet<string>;

  /** Disposal callbacks for the servers created by Nest. */
  private readonly disposeClients: (() => Promise<void>)[] = [];
  // #endregion

  // #region Constructor
  /** Keeps the command connection and readiness check for future Socket.IO servers. */
  public constructor(
    app: INestApplicationContext,
    private readonly redis: Redis,
    allowedOrigins: readonly string[],
    private readonly readiness: SocketIoRedisReadiness,
    private readonly gates?: RealtimeAdmissionGates,
  ) {
    super(app);
    this.allowedOrigins = new Set(allowedOrigins);
  }
  // #endregion

  // #region Methods
  /** Applies identical origin and Redis guards to long polling and WebSocket upgrades. */
  public override createIOServer(port: number, options?: ServerOptions): Server {
    const admissions = new WeakMap<IncomingMessage, number>();
    const transports = new Set<Socket['conn']>();
    let epoch = 0;
    const serverOptions: Partial<ServerOptions> = {
      ...options,
      serveClient: false,
      connectionStateRecovery: undefined,
      cors: { origin: [...this.allowedOrigins], credentials: true },
      allowRequest: (request, callback) => {
        if (!this.isAllowedOrigin(request.headers.origin)) {
          callback(refusedOrigin, false);
          return;
        }
        if (!available()) {
          callback(unavailable, false);
          return;
        }
        admissions.set(request, epoch);
        callback(null, true);
      },
    };
    // Nest types these options as complete although Socket.IO supplies the remaining defaults.
    const server: Server = super.createIOServer(port, serverOptions as ServerOptions);
    const closeTransports = (): void => {
      epoch += 1;
      for (const transport of transports) transport.close(true);
    };
    const fanOut = new SocketIoRedisFanOut(this.redis, closeTransports);
    const available = (): boolean => fanOut.available && (this.gates?.ready ?? true);
    const isCurrent = (request: IncomingMessage): boolean =>
      available() && admissions.get(request) === epoch;

    server.adapter(createAdapter(fanOut.publisher, fanOut.subscriber));
    server.engine.on('connection', (transport: Socket['conn']) => {
      if (!isCurrent(transport.request)) {
        transport.close(true);
        return;
      }
      // Include an Engine.IO transport still waiting to open its first Socket.IO namespace.
      transports.add(transport);
      transport.once('close', () => transports.delete(transport));
    });
    const guardNamespace = (socket: Socket, next: (error?: Error) => void): void => {
      next(isCurrent(socket.request) ? undefined : new Error(unavailable));
    };
    server.use(guardNamespace);
    server.on('new_namespace', (namespace) => namespace.use(guardNamespace));

    const untrack = this.readiness.track(() => fanOut.available);
    const unwatch = this.gates?.onUnavailable(closeTransports);
    this.disposeClients.push(async () => {
      untrack();
      unwatch?.();
      await fanOut.shutDown();
    });
    return server;
  }

  /** Checks the origin before the gateway sees a credential. */
  public isAllowedOrigin(origin: string | undefined): boolean {
    return origin !== undefined && this.allowedOrigins.has(origin);
  }

  /** Detaches Redis watchers and closes the adapter clients after Nest closes Socket.IO. */
  public override async dispose(): Promise<void> {
    await Promise.all(this.disposeClients.splice(0).map((dispose) => dispose()));
  }
  // #endregion
}

/** Owns the two Redis connections and the acknowledged subscriptions of one Socket.IO server. */
class SocketIoRedisFanOut {
  // #region Properties
  /** Exact subscription names requested by the Socket.IO Redis adapter. */
  private readonly channels = new Set<string>();

  /** Exact pattern subscriptions requested by the same adapter. */
  private readonly patterns = new Set<string>();

  /** Invalidates a pending acknowledgement when the subscriptions or their connection change. */
  private subscriptionEpoch = 0;

  /** Whether Redis acknowledged all current subscriptions in the current epoch. */
  private subscribed = false;

  /** Whether shutdown has begun. */
  private closed = false;

  /** Redis socket for outbound packets. */
  private readonly publishing: ResilientRedisClient;

  /** Redis socket for restoring and receiving subscriptions. */
  private readonly listening: ResilientRedisClient;

  /** Socket.IO's ioredis publishing interface. Drops messages during outages. */
  public readonly publisher;

  /** Socket.IO's ioredis subscription interface. Retains only channel and pattern names. */
  public readonly subscriber;

  /** Subscription restoration listener. */
  private readonly onSubscriberReady = (): void => {
    void this.restoreSubscriptions();
  };

  /** Invalidates every local transport when the command or publication connection is lost. */
  private readonly onConnectionLost = (): void => {
    this.disconnectTransports();
  };

  /** Invalidate old ACKs as well as local transports when the subscriber loses its connection. */
  private readonly onSubscriberLost = (): void => {
    this.subscriptionEpoch += 1;
    this.subscribed = false;
    this.disconnectTransports();
  };

  /** Availability requires Redis readiness and confirmed subscription acknowledgements. */
  public get available(): boolean {
    return (
      !this.closed &&
      this.command.status === 'ready' &&
      this.publishing.status === 'ready' &&
      this.listening.status === 'ready' &&
      this.subscribed
    );
  }
  // #endregion

  // #region Constructor
  /** Creates bounded Redis clients and observes connection loss before permitting handshakes. */
  public constructor(
    private readonly command: Redis,
    private readonly disconnectTransports: () => void,
  ) {
    this.publishing = this.openClient('publisher');
    this.listening = this.openClient('subscriber');
    this.publisher = {
      on: this.publishing.on.bind(this.publishing),
      off: this.publishing.off.bind(this.publishing),
      publish: (channel: string, payload: string | Buffer): Promise<number> =>
        this.available ? this.publishing.publish(channel, payload) : Promise.resolve(0),
      send_command: (
        command: string,
        args: string[],
        callback: (error: Error | null, result?: unknown) => void,
      ): void => {
        const channel = args[1];
        if (
          command !== 'PUBSUB' ||
          args.length !== 2 ||
          args[0] !== 'NUMSUB' ||
          channel === undefined ||
          !this.available
        ) {
          callback(new Error(unavailable));
          return;
        }
        void this.publishing.call('PUBSUB', 'NUMSUB', channel).then(
          (result) => {
            callback(null, result);
          },
          (error: unknown) => {
            callback(error instanceof Error ? error : new Error(unavailable));
          },
        );
      },
    };
    this.subscriber = {
      on: this.listening.on.bind(this.listening),
      off: this.listening.off.bind(this.listening),
      subscribe: (channels: readonly string[]): void => {
        for (const channel of channels) this.channels.add(channel);
        void this.restoreSubscriptions();
      },
      psubscribe: (pattern: string): void => {
        this.patterns.add(pattern);
        void this.restoreSubscriptions();
      },
      unsubscribe: (channels: readonly string[]): void => {
        for (const channel of channels) this.channels.delete(channel);
        if (this.listening.status === 'ready') void this.listening.unsubscribe(...channels);
      },
      punsubscribe: (pattern: string): void => {
        this.patterns.delete(pattern);
        if (this.listening.status === 'ready') void this.listening.punsubscribe(pattern);
      },
    };
    this.listening.on('ready', this.onSubscriberReady);
    for (const event of lostEvents) {
      this.command.on(event, this.onConnectionLost);
      this.publishing.on(event, this.onConnectionLost);
      this.listening.on(event, this.onSubscriberLost);
    }
  }
  // #endregion

  // #region Methods
  /** Keeps kit connection naming and error handling while disabling every command replay. */
  private openClient(role: 'publisher' | 'subscriber'): ResilientRedisClient {
    return new ResilientRedisClient({
      ...pubSubClientOptions(this.command.options, role),
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: false,
      maxRetriesPerRequest: 0,
    });
  }

  /** Reads the current subscriber state again after commands settle. */
  private acceptsSubscriptions(): boolean {
    return !this.closed && this.listening.status === 'ready';
  }

  /** Restores bounded control-plane subscriptions and admits traffic only after Redis ACKs them. */
  private async restoreSubscriptions(): Promise<void> {
    if (!this.acceptsSubscriptions()) return;
    const epoch = ++this.subscriptionEpoch;
    this.subscribed = false;
    const pending: Promise<unknown>[] = [];
    if (this.channels.size > 0) pending.push(this.listening.subscribe(...this.channels));
    if (this.patterns.size > 0) pending.push(this.listening.psubscribe(...this.patterns));
    try {
      await Promise.all(pending);
    } catch {
      // The Redis client logs sanitized command failures. A failed subscription keeps admission off.
      return;
    }
    if (this.subscriptionEpoch === epoch && this.acceptsSubscriptions()) {
      this.subscribed = true;
    }
  }

  /** Removes watchers and closes both connections without replaying outstanding packets. */
  public async shutDown(): Promise<void> {
    this.closed = true;
    this.listening.off('ready', this.onSubscriberReady);
    for (const event of lostEvents) {
      this.command.off(event, this.onConnectionLost);
      this.publishing.off(event, this.onConnectionLost);
      this.listening.off(event, this.onSubscriberLost);
    }
    await Promise.all([this.publishing.shutDown(), this.listening.shutDown()]);
  }
  // #endregion
}
