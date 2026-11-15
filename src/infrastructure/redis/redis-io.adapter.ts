import type { IncomingMessage } from 'node:http';

import { Logger, type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis, type Command, type RedisOptions } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

import { CONNECTION_NAME, type RedisConnection } from './redis-connection.js';

/**
 * Type AdapterClientRole
 *
 * @description
 * What one of the two Redis connections of the Socket.IO adapter does: `publisher` sends the
 * packets broadcast by this instance, `subscriber` receives those of the other instances.
 *
 * @type {'publisher' | 'subscriber'}
 */
type AdapterClientRole = 'publisher' | 'subscriber';

/**
 * Type LegacyRedisOptions
 *
 * @description
 * Options of an adapter connection. The replies keep the classic mapping of ioredis, the one the
 * main connection uses and `@socket.io/redis-adapter` reads.
 *
 * @type {RedisOptions & { replyMapping?: 'legacy' }}
 */
type LegacyRedisOptions = RedisOptions & { replyMapping?: 'legacy' };

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
 * Constant logger
 *
 * @description
 * Logger of the adapter connections. It never writes the address, which may carry a password,
 * nor the arguments of a command, which name rooms.
 *
 * @type {Logger}
 */
const logger: Logger = new Logger('RedisIoAdapter');

/**
 * Function ignoreAdapterClientError
 *
 * @description
 * `error` listener of the adapter connections: the main connection reports the outage once for
 * every connection of the gateway.
 */
function ignoreAdapterClientError(): void {
  // RedisConnection.reportOutage logs the outage.
}

/**
 * Class AdapterRedisClient
 *
 * @description
 * ioredis client of the Socket.IO adapter, built from the options of the main connection as
 * `duplicate()` does, with two differences that keep the process up while Redis is unreachable:
 *
 * - The offline queue stays on and a queued command is retried without limit, because the adapter
 *   subscribes as soon as it is created, usually before Redis answers. Its commands wait for the
 *   connection instead of failing at start-up or during an outage.
 * - The adapter sends every command (`PSUBSCRIBE`, `PUBLISH`, `UNSUBSCRIBE` and the others) without
 *   handling its promise, so a failed command would be an unhandled rejection, which stops Node.
 *   This client settles each one itself: a command that could not complete because the shutdown
 *   closed the connection is dropped silently, any other failure is logged.
 *
 * Its `error` events are not logged: it reaches the same server with the same credentials as the
 * main connection, which reports an outage once.
 */
class AdapterRedisClient extends Redis {
  // #region Properties
  /**
   * Property closing
   *
   * @description
   * Whether `shutDown` started, after which a failed command is expected.
   *
   * @type {boolean}
   */
  private closing: boolean = false;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Opens the connection without waiting for it.
   *
   * @param {LegacyRedisOptions} options - Options of the main connection with the overrides of the adapter.
   * @constructor
   */
  public constructor(options: LegacyRedisOptions) {
    super(options);
    // A listener of its own keeps ioredis and the adapter from writing a warning to the standard
    // error on every reconnection attempt.
    this.on('error', ignoreAdapterClientError);
  }
  // #endregion

  // #region Methods
  /**
   * Method sendCommand
   *
   * @description
   * Sends a command as ioredis does, after attaching the handler that settles its promise. The
   * caller still receives the same promise and may await it.
   *
   * @param {Command} command - Command to send.
   * @param {Parameters<Redis['sendCommand']>[1]} stream - Stream of a pipeline, if any.
   * @returns {unknown} What ioredis returns: the promise of the command.
   */
  public override sendCommand(
    command: Command,
    stream?: Parameters<Redis['sendCommand']>[1],
  ): unknown {
    command.promise.catch((error: unknown) => {
      this.reportFailure(command.name, error);
    });
    return super.sendCommand(command, stream);
  }

  /**
   * Method reportFailure
   *
   * @description
   * Logs a failed command with its name and an error code at most, unless the shutdown caused it.
   *
   * @param {string} name - Name of the command, such as `publish`.
   * @param {unknown} error - Rejection reason of the command.
   */
  private reportFailure(name: string, error: unknown): void {
    if (this.closing) {
      return;
    }
    const reason: string =
      error instanceof Error
        ? 'code' in error && typeof error.code === 'string'
          ? error.code
          : error.name
        : 'unknown error';
    logger.warn(`A Redis command of the Socket.IO adapter failed: ${name} (${reason}).`);
  }

  /**
   * Method shutDown
   *
   * @description
   * Closes the connection during the shutdown. A ready connection is closed with `QUIT`, after the
   * unsubscriptions the adapter sent while its server closed; any other state, or a failed `QUIT`,
   * closes the socket at once, drops the commands still queued and stops the reconnection attempts.
   *
   * @returns {Promise<void>} Resolves once the connection is closed.
   */
  public async shutDown(): Promise<void> {
    this.closing = true;
    if (this.status === 'ready') {
      try {
        await this.quit();
        return;
      } catch {
        // The connection broke during the shutdown: there is nothing left to complete.
      }
    }
    this.disconnect();
  }
  // #endregion
}

/**
 * Class RedisIoAdapter
 *
 * @description
 * Socket.IO adapter of the realtime gateway, registered with `app.useWebSocketAdapter` before the
 * application initializes, so every `@WebSocketGateway` runs on the server it creates.
 *
 * - Fan-out: `@socket.io/redis-adapter` publishes what this instance broadcasts and receives what
 *   the others broadcast, through a publisher and a subscriber opened from the options of the main
 *   Redis connection (see `AdapterRedisClient`). While Redis is down, broadcasts wait in memory
 *   and readiness answers 503 through the main connection.
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
   * Property connection
   *
   * @description
   * Main Redis connection, whose options the adapter connections start from.
   *
   * @type {RedisConnection}
   * @readonly
   */
  private readonly connection: RedisConnection;

  /**
   * Property clients
   *
   * @description
   * Publisher and subscriber of each server this adapter created, closed by `dispose`.
   *
   * @type {AdapterRedisClient[]}
   * @readonly
   */
  private readonly clients: AdapterRedisClient[] = [];
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Prepares the adapter; no Redis connection is opened before `createIOServer`.
   *
   * @param {INestApplicationContext} app - Application whose HTTP server Socket.IO attaches to.
   * @param {RedisConnection} connection - Main Redis connection of the gateway.
   * @param {readonly string[]} allowedOrigins - Exact origins allowed to open a socket.
   * @constructor
   */
  public constructor(
    app: INestApplicationContext,
    connection: RedisConnection,
    allowedOrigins: readonly string[],
  ) {
    super(app);
    this.connection = connection;
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
    server.adapter(createAdapter(this.open('publisher'), this.open('subscriber')));
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
   * connection closes.
   *
   * @returns {Promise<void>} Resolves once both connections of every server are closed.
   */
  public override async dispose(): Promise<void> {
    await Promise.all(
      this.clients.splice(0).map(async (client: AdapterRedisClient) => client.shutDown()),
    );
  }

  /**
   * Method open
   *
   * @description
   * Opens one adapter connection from the options of the main one, under a name of its own.
   *
   * @param {AdapterClientRole} role - What the connection is for.
   * @returns {AdapterRedisClient} The new connection, already connecting.
   */
  private open(role: AdapterClientRole): AdapterRedisClient {
    const client: AdapterRedisClient = new AdapterRedisClient({
      ...this.connection.client.options,
      replyMapping: 'legacy',
      connectionName: `${CONNECTION_NAME}-${role}`,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    this.clients.push(client);
    return client;
  }
  // #endregion
}
