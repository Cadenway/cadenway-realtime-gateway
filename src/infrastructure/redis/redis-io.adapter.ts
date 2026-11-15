import type { IncomingMessage } from 'node:http';

import { createPubSubClients, type PubSubClients } from '@cadenway/nest-common/redis';
import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Constant REFUSED_ORIGIN_MESSAGE
 *
 * @description
 * Message of the 403 a handshake from an origin outside `ALLOWED_ORIGINS` receives. It repeats
 * nothing of the request.
 *
 * @type {string}
 */
const REFUSED_ORIGIN_MESSAGE: string = 'Origin not allowed';

/**
 * Class RedisIoAdapter
 *
 * @description
 * Socket.IO adapter of the realtime gateway, registered with `app.useWebSocketAdapter` before the
 * application initializes, so every `@WebSocketGateway` runs on the server it creates.
 *
 * - Fan-out: `@socket.io/redis-adapter` publishes what this instance broadcasts and receives what
 *   the others broadcast, through the publisher and the subscriber `createPubSubClients` of
 *   `@cadenway/nest-common/redis` opens from the options of the main Redis connection. Their
 *   offline queue stays on and a queued command waits without limit, because the adapter
 *   subscribes as soon as it is created, usually before Redis answers; and, as
 *   `ResilientRedisClient`s, they settle the promise of every command the adapter drops, so a
 *   failed `PUBLISH` or `UNSUBSCRIBE` cannot stop the process. While Redis is down, broadcasts wait
 *   in memory, the main connection logs the outage once for the three, and readiness answers 503.
 * - Handshake: browsers do not apply CORS to a WebSocket upgrade, so `allowRequest` compares the
 *   `Origin` of every new connection, WebSocket or long-polling, to `ALLOWED_ORIGINS` by exact
 *   string equality. A request without `Origin` or from another origin is refused with 403 before
 *   it reaches a gateway. Authentication (the single-use ticket in `auth.token`) comes after.
 * - The long-polling transport answers CORS for the same origins, with credentials.
 * - The client bundle is not served: the web application ships its own `socket.io-client`.
 *
 * Connection state recovery stays off, as `rules/connection.md` requires: the Redis adapter does
 * not support it.
 */
export class RedisIoAdapter extends IoAdapter {
  // #region Properties
  /**
   * Property allowedOrigins
   *
   * @description
   * Exact origins a handshake may come from, as validated by `ALLOWED_ORIGINS`.
   *
   * @type {ReadonlySet<string>}
   * @readonly
   */
  private readonly allowedOrigins: ReadonlySet<string>;

  /**
   * Property redis
   *
   * @description
   * Main Redis connection, whose options the adapter connections start from.
   *
   * @type {Redis}
   * @readonly
   */
  private readonly redis: Redis;

  /**
   * Property clients
   *
   * @description
   * Publisher and subscriber of each server this adapter created, closed by `dispose`.
   *
   * @type {PubSubClients[]}
   * @readonly
   */
  private readonly clients: PubSubClients[] = [];
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Prepares the adapter; no Redis connection is opened before `createIOServer`.
   *
   * @param {INestApplicationContext} app - Application whose HTTP server Socket.IO attaches to.
   * @param {Redis} redis - Main Redis connection of the gateway.
   * @param {readonly string[]} allowedOrigins - Exact origins allowed to open a socket.
   * @constructor
   */
  public constructor(
    app: INestApplicationContext,
    redis: Redis,
    allowedOrigins: readonly string[],
  ) {
    super(app);
    this.redis = redis;
    this.allowedOrigins = new Set(allowedOrigins);
  }
  // #endregion

  // #region Methods
  /**
   * Method createIOServer
   *
   * @description
   * Creates the Socket.IO server with the origin check, CORS and the Redis fan-out, whatever the
   * options of the `@WebSocketGateway` decorator say on those points.
   *
   * @param {number} port - Port of the gateway; 0 attaches to the HTTP server of the application.
   * @param {ServerOptions} options - Options of the `@WebSocketGateway` decorator, if any.
   * @returns {Server} The Socket.IO server.
   */
  public override createIOServer(port: number, options?: ServerOptions): Server {
    const serverOptions: Partial<ServerOptions> = {
      ...options,
      serveClient: false,
      cors: { origin: [...this.allowedOrigins], credentials: true },
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null | undefined, success: boolean) => void,
      ): void => {
        const allowed: boolean = this.isAllowedOrigin(request.headers.origin);
        callback(allowed ? null : REFUSED_ORIGIN_MESSAGE, allowed);
      },
    };
    // NestJS types the options as complete, while the Socket.IO server takes a partial set and
    // fills in its defaults.
    const server: Server = super.createIOServer(port, serverOptions as ServerOptions);
    const clients: PubSubClients = createPubSubClients(this.redis);
    this.clients.push(clients);
    server.adapter(createAdapter(clients.publisher, clients.subscriber));
    return server;
  }

  /**
   * Method isAllowedOrigin
   *
   * @description
   * Tells whether an `Origin` header names one of the allowed origins, exactly.
   *
   * @param {string | undefined} origin - `Origin` header of the handshake, absent outside a browser.
   * @returns {boolean} `true` for an allowed origin; `false` for any other or none.
   */
  public isAllowedOrigin(origin: string | undefined): boolean {
    return origin !== undefined && this.allowedOrigins.has(origin);
  }

  /**
   * Method dispose
   *
   * @description
   * Closes the adapter connections once NestJS closed the Socket.IO servers, before the main
   * connection closes. A ready connection is closed with `QUIT`, after the unsubscriptions the
   * adapter sent while its server closed; any other state closes the socket at once, drops the
   * commands still queued without a log line and stops the reconnection attempts.
   *
   * @returns {Promise<void>} Resolves once both connections of every server are closed.
   */
  public override async dispose(): Promise<void> {
    await Promise.all(
      this.clients.splice(0).map(async (clients: PubSubClients) => clients.shutDown()),
    );
  }
  // #endregion
}
