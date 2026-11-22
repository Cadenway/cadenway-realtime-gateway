import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';

import type { INestApplicationContext } from '@nestjs/common';
import type { Redis, RedisOptions } from 'ioredis';
import type { Server } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RedisIoAdapter, SocketIoRedisReadiness } from './redis-io.adapter.js';

const { createRedis } = vi.hoisted(() => ({
  createRedis: vi.fn<(options: RedisOptions) => Redis>(),
}));

vi.mock('@cadenway/nest-common/redis', () => ({
  ResilientRedisClient: function (options: RedisOptions): Redis {
    return createRedis(options);
  },
  pubSubClientOptions: (base: RedisOptions, role: string): RedisOptions => ({
    ...base,
    connectionName: role,
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
  }),
}));

const origin = 'https://app.cadenway.test';
const polling = '/socket.io/?EIO=4&transport=polling';

/**
 * Constant adapter
 *
 * @description
 * Adapter allowing the web application only. Neither the application nor the Redis connection is
 * used before `createIOServer`, so empty stand-ins are enough for the origin check.
 *
 * @type {RedisIoAdapter}
 */
const adapter: RedisIoAdapter = new RedisIoAdapter(
  {} as INestApplicationContext,
  {} as Redis,
  [origin],
  new SocketIoRedisReadiness(),
);

describe('RedisIoAdapter', () => {
  it('accepts the exact origin of the web application', () => {
    expect(adapter.isAllowedOrigin('https://app.cadenway.test')).toBe(true);
  });

  it.each([
    ['no origin', undefined],
    ['another site', 'https://evil.test'],
    ['a lookalike that starts with the allowed origin', 'https://app.cadenway.test.evil.test'],
    ['the website', 'https://cadenway.test'],
    ['another scheme', 'http://app.cadenway.test'],
    ['a trailing slash', 'https://app.cadenway.test/'],
    ['uppercase letters', 'https://APP.cadenway.test'],
    ['an explicit default port', 'https://app.cadenway.test:443'],
    ['the opaque origin of a sandboxed document', 'null'],
  ])('refuses %s', (_label: string, origin: string | undefined) => {
    expect(adapter.isAllowedOrigin(origin)).toBe(false);
  });
});

class TestRedis extends EventEmitter {
  // #region Properties
  /** Controlled connection status and command acknowledgements for the active epoch. */
  public status: Redis['status'] = 'connecting';
  public channels = vi.fn<(...channels: string[]) => Promise<number>>().mockResolvedValue(3);
  public patterns = vi.fn<(...patterns: string[]) => Promise<number>>().mockResolvedValue(1);
  public publish = vi.fn<(channel: string, data: Buffer) => Promise<number>>().mockResolvedValue(1);
  public eval = vi.fn<Redis['eval']>().mockResolvedValue(1);
  public unsubscribe = vi.fn<(...channels: string[]) => Promise<number>>().mockResolvedValue(0);
  public punsubscribe = vi.fn<(pattern: string) => Promise<number>>().mockResolvedValue(0);
  public shutDown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  // #endregion

  // #region Constructor
  /** Retains the options from the real adapter for assertions. */
  public constructor(public readonly options: RedisOptions) {
    super();
  }
  // #endregion

  // #region Methods
  /** Returns the controlled channel acknowledgement. */
  public subscribe(...channels: string[]): Promise<number> {
    return this.channels(...channels);
  }

  /** Returns the controlled pattern acknowledgement. */
  public psubscribe(...patterns: string[]): Promise<number> {
    return this.patterns(...patterns);
  }

  /** Updates status before the corresponding ioredis event fires. */
  public transition(status: Redis['status']): void {
    this.status = status;
    this.emit(status);
  }
  // #endregion
}

function pendingAcknowledgement(): {
  promise: Promise<number>;
  resolve: (count: number) => void;
  reject: (cause: Error) => void;
} {
  let resolve!: (count: number) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<number>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitForReady(readiness: SocketIoRedisReadiness): Promise<void> {
  await vi.waitFor(() => {
    expect(() => {
      readiness.assertAvailable();
    }).not.toThrow();
  });
}

function connect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
}

describe('RedisIoAdapter connection lifecycle', () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    createRedis.mockReset();
  });

  /** Uses real Socket.IO handshakes with deterministic Redis acknowledgements. */
  async function fixture(): Promise<{
    command: TestRedis;
    publisher: TestRedis;
    subscriber: TestRedis;
    readiness: SocketIoRedisReadiness;
    server: Server;
    url: string;
    client: (token: string) => Socket;
  }> {
    const transport = createServer();
    const sockets: Socket[] = [];
    const clients = new Map<string, TestRedis>();
    const command = new TestRedis({});
    createRedis.mockImplementation((options) => {
      const redis = new TestRedis(options);
      clients.set(String(options.connectionName), redis);
      return redis as unknown as Redis;
    });
    const readiness = new SocketIoRedisReadiness();
    const ioAdapter = new RedisIoAdapter(
      transport as unknown as INestApplicationContext,
      command as unknown as Redis,
      [origin],
      readiness,
    );
    const server = ioAdapter.createIOServer(0);
    dispose = async (): Promise<void> => {
      for (const socket of sockets) socket.disconnect();
      await ioAdapter.close(server);
      await ioAdapter.dispose();
    };
    transport.listen(0, '127.0.0.1');
    await once(transport, 'listening');
    const address = transport.address();
    const publisher = clients.get('publisher');
    const subscriber = clients.get('subscriber');
    if (
      address === null ||
      typeof address === 'string' ||
      publisher === undefined ||
      subscriber === undefined
    ) {
      throw new Error('Socket.IO fixture is unavailable.');
    }
    const url = `http://127.0.0.1:${String(address.port)}`;
    return {
      command,
      publisher,
      subscriber,
      readiness,
      server,
      url,
      client: (token) => {
        const socket = io(url, {
          extraHeaders: { Origin: origin },
          transports: ['websocket'],
          auth: { token },
          reconnection: false,
          forceNew: true,
          autoConnect: false,
        });
        sockets.push(socket);
        return socket;
      },
    };
  }

  it('opens handshakes only after both subscription commands are acknowledged', async () => {
    const { command, publisher, subscriber, readiness, url } = await fixture();
    const channelAck = pendingAcknowledgement();
    const patternAck = pendingAcknowledgement();
    subscriber.channels.mockReturnValueOnce(channelAck.promise);
    subscriber.patterns.mockReturnValueOnce(patternAck.promise);
    command.transition('ready');
    publisher.transition('ready');
    subscriber.transition('ready');

    for (const redis of [publisher, subscriber]) {
      expect(redis.options).toMatchObject({
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        autoResubscribe: false,
        maxRetriesPerRequest: 0,
      });
    }
    expect(subscriber.channels).toHaveBeenCalledOnce();
    expect(subscriber.patterns).toHaveBeenCalledExactlyOnceWith('socket.io#/#*');
    expect(() => {
      readiness.assertAvailable();
    }).toThrow('Realtime unavailable');
    channelAck.resolve(3);
    await request(url).get(polling).set('Origin', origin).expect(403, {
      code: 4,
      message: 'Realtime unavailable',
    });
    patternAck.resolve(1);
    await waitForReady(readiness);
    await request(url).get(polling).set('Origin', origin).expect(200);
  });

  it('does not open a polling transport when its shared admission budget is exhausted', async () => {
    const { command, publisher, subscriber, readiness, server, url } = await fixture();
    command.transition('ready');
    publisher.transition('ready');
    subscriber.transition('ready');
    await waitForReady(readiness);
    command.eval.mockResolvedValueOnce(0);
    await request(url).get(polling).set('Origin', origin).expect(403, {
      code: 4,
      message: 'Realtime unavailable',
    });
    expect(server.engine.clientsCount).toBe(0);
    await request(url).get(polling).set('Origin', origin).expect(200);
    expect(server.engine.clientsCount).toBe(1);
  });

  it.each(['command', 'publisher', 'subscriber'] as const)(
    'drops publications and requires a fresh socket after the %s connection is lost',
    async (role) => {
      const state = await fixture();
      const { command, publisher, subscriber, readiness, server, url, client } = state;
      const sessions: unknown[] = [];
      server.on('connection', (socket) => {
        sessions.push(socket.handshake.auth.token);
      });
      command.transition('ready');
      publisher.transition('ready');
      subscriber.transition('ready');
      await waitForReady(readiness);

      const previous = client('before');
      await connect(previous);
      const previousId = previous.id;
      server.emit('test:packet', 'before-outage');
      expect(publisher.publish).toHaveBeenCalledOnce();

      const disconnected = new Promise<string>((resolve) => {
        previous.once('disconnect', resolve);
      });
      state[role].transition('close');
      expect(await disconnected).toBe('transport close');
      expect(() => {
        readiness.assertAvailable();
      }).toThrow('Realtime unavailable');
      server.emit('test:packet', 'during-outage');
      expect(publisher.publish).toHaveBeenCalledOnce();
      await request(url).get(polling).set('Origin', origin).expect(403);

      state[role].transition('ready');
      await waitForReady(readiness);
      expect(subscriber.channels).toHaveBeenCalledTimes(role === 'subscriber' ? 2 : 1);
      expect(publisher.publish).toHaveBeenCalledOnce();
      const fresh = client('after');
      await connect(fresh);
      expect(fresh.id).not.toBe(previousId);
      expect(sessions).toEqual(['before', 'after']);
    },
  );

  it('cannot reopen handshakes with acknowledgements from a superseded connection', async () => {
    const { command, publisher, subscriber, readiness, url } = await fixture();
    const staleAck = pendingAcknowledgement();
    const currentAck = pendingAcknowledgement();
    subscriber.channels
      .mockReturnValueOnce(staleAck.promise)
      .mockReturnValueOnce(currentAck.promise);
    command.transition('ready');
    publisher.transition('ready');
    subscriber.transition('ready');
    subscriber.transition('close');
    subscriber.transition('ready');
    staleAck.resolve(3);
    await request(url).get(polling).set('Origin', origin).expect(403);

    subscriber.transition('end');
    subscriber.transition('ready');
    currentAck.resolve(3);
    await waitForReady(readiness);
    expect(subscriber.channels).toHaveBeenCalledTimes(3);
  });

  it('retries subscription on the same connection after all commands from the first attempt settle', async () => {
    const { command, publisher, subscriber, readiness } = await fixture();
    const patternAck = pendingAcknowledgement();
    subscriber.channels.mockRejectedValueOnce(new Error('Temporary subscription failure.'));
    subscriber.patterns.mockReturnValueOnce(patternAck.promise);
    vi.useFakeTimers();
    try {
      command.transition('ready');
      publisher.transition('ready');
      subscriber.transition('ready');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(subscriber.channels).toHaveBeenCalledOnce();
      expect(() => {
        readiness.assertAvailable();
      }).toThrow('Realtime unavailable');

      patternAck.resolve(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(subscriber.channels).toHaveBeenCalledTimes(2);
      expect(subscriber.patterns).toHaveBeenCalledTimes(2);
      expect(() => {
        readiness.assertAvailable();
      }).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
