import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config/app-config.js';

/**
 * Constant ALLOWED_ORIGIN
 *
 * @description
 * Origin of the web application in this test, the only allowed one.
 *
 * @type {string}
 */
const ALLOWED_ORIGIN = 'https://app.cadenway.test';

/**
 * Constant REFUSED_ORIGINS
 *
 * @description
 * Origins a handshake or a preflight must be refused from: another site, a lookalike that starts
 * with the allowed origin, the website (allowed by the API gateway, not here) and the opaque
 * origin of a sandboxed document.
 *
 * @type {readonly string[]}
 */
const REFUSED_ORIGINS: readonly string[] = [
  'https://evil.test',
  'https://app.cadenway.test.evil.test',
  'https://cadenway.test',
  'null',
];

/**
 * Constant POLLING_HANDSHAKE
 *
 * @description
 * Path of the first request of a Socket.IO client on the long-polling transport.
 *
 * @type {string}
 */
const POLLING_HANDSHAKE = '/socket.io/?EIO=4&transport=polling';

/**
 * Function redisImage
 *
 * @description
 * Reads the Redis image of `compose.dev.yaml`, so the tests run the image the workstation runs and
 * the pin Renovate updates lives in one file.
 *
 * @returns {string} The image reference, tag and digest.
 * @throws {Error} When `compose.dev.yaml` names no Redis image.
 */
function redisImage(): string {
  const compose: string = readFileSync(new URL('../compose.dev.yaml', import.meta.url), 'utf8');
  const image: string | undefined = /^\s*image:\s*(redis:\S+)\s*$/mu.exec(compose)?.[1];
  if (image === undefined) {
    throw new Error('compose.dev.yaml names no Redis image.');
  }
  return image;
}

/**
 * Function testEnvironment
 *
 * @description
 * Environment of the gateway under test: the disposable Redis, a signing key generated for this
 * run (no key is ever committed) and service addresses nothing listens on, since nothing calls a
 * service yet.
 *
 * @param {string} redisUrl - Address of the disposable Redis.
 * @returns {Record<string, string>} The variables to stub.
 */
function testEnvironment(redisUrl: string): Record<string, string> {
  const jwk: JsonWebKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const privateJwk: string = JSON.stringify({
    kty: 'OKP',
    crv: 'Ed25519',
    x: jwk.x,
    d: jwk.d,
    kid: randomBytes(8).toString('hex'),
  });
  return {
    NODE_ENV: 'test',
    PORT: '3001',
    LOG_LEVEL: 'info',
    REDIS_URL: redisUrl,
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    INTERNAL_TOKEN_ISSUER: 'realtime-gateway',
    INTERNAL_TOKEN_PRIVATE_JWK: privateJwk,
    IDENTITY_SERVICE_URL: 'http://127.0.0.1:1',
    TASK_SERVICE_URL: 'http://127.0.0.1:1',
  };
}

/**
 * Function lineSink
 *
 * @description
 * Collects the log lines an application writes, one entry per line.
 *
 * @param {string[]} lines - Array that receives the lines.
 * @returns {Writable} The stream to give as log destination.
 */
function lineSink(lines: string[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      done();
    },
  });
}

/**
 * Function startApplication
 *
 * @description
 * Creates an instance of the gateway with the same start-up as `main.ts` and listens on a free
 * loopback port, as Socket.IO clients need a real address.
 *
 * @param {Readonly<AppConfig>} config - Validated configuration.
 * @param {string[]} logLines - Array that receives the log lines of the instance.
 * @returns {Promise<{ app: NestExpressApplication; url: string }>} The listening instance and its address.
 */
async function startApplication(
  config: Readonly<AppConfig>,
  logLines: string[],
): Promise<{ app: NestExpressApplication; url: string }> {
  const { createRealtimeApplication } = await import('../src/realtime-application.js');
  const app: NestExpressApplication = await createRealtimeApplication(config, lineSink(logLines));
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

/**
 * Function handshake
 *
 * @description
 * Opens one Socket.IO client without reconnection and reports how the attempt ended: closed by the
 * server after it connected, or refused before.
 *
 * @param {string} url - Address of the gateway.
 * @param {string | undefined} origin - `Origin` header to send; none when undefined.
 * @returns {Promise<{ connected: boolean; reason: string }>} Whether the socket connected, and the disconnect reason or the error message.
 */
async function handshake(
  url: string,
  origin: string | undefined,
): Promise<{ connected: boolean; reason: string }> {
  const socket: Socket = io(url, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { token: 'not-a-ticket' },
    extraHeaders: origin === undefined ? {} : { Origin: origin },
  });
  try {
    return await new Promise((resolve) => {
      let connected = false;
      socket.once('connect', () => {
        connected = true;
      });
      socket.once('disconnect', (reason: string) => {
        resolve({ connected, reason });
      });
      socket.once('connect_error', (error: Error) => {
        resolve({ connected, reason: error.message });
      });
    });
  } finally {
    socket.close();
  }
}

/**
 * Function waitFor
 *
 * @description
 * Polls a probe until it returns the expected value or the time runs out: Redis connections and
 * subscriptions settle a moment after the application starts or stops.
 *
 * @param {() => Promise<T>} probe - Reads the current value.
 * @param {T} expected - Value to wait for.
 * @returns {Promise<T>} The last value read.
 */
async function waitFor<T>(probe: () => Promise<T>, expected: T): Promise<T> {
  const deadline: number = Date.now() + 10_000;
  let value: T = await probe();
  while (value !== expected && Date.now() < deadline) {
    await delay(200);
    value = await probe();
  }
  return value;
}

describe('realtime gateway start-up', () => {
  const logLines: string[] = [];
  let redis: StartedRedisContainer;
  let redisStopped = false;
  let redisAddress: string;
  let observer: Redis;
  let config: Readonly<AppConfig>;
  let app: NestExpressApplication;
  let appClosed = false;
  let url: string;
  let server: App;

  /**
   * Function readinessStatus
   *
   * @description
   * Polls `/health/ready` until it answers the expected status or the time runs out.
   *
   * @param {number} expected - Status to wait for.
   * @returns {Promise<number>} The last readiness status.
   */
  async function readinessStatus(expected: number): Promise<number> {
    return waitFor(async () => (await request(server).get('/health/ready')).status, expected);
  }

  /**
   * Function adapterConnections
   *
   * @description
   * Counts the Redis connections of one role announced by `CLIENT SETNAME`.
   *
   * @param {string} name - Connection name, such as `realtime-gateway-subscriber`.
   * @returns {Promise<number>} How many connections carry that name.
   */
  async function adapterConnections(name: string): Promise<number> {
    const list = String(await observer.call('CLIENT', 'LIST'));
    return list.split('\n').filter((line: string) => line.includes(` name=${name} `)).length;
  }

  /**
   * Function fanOutSubscribers
   *
   * @description
   * Counts the instances subscribed to the request channel of the default namespace, which is
   * how the Redis adapter counts the servers it reaches.
   *
   * @returns {Promise<number>} The number of subscribers.
   */
  async function fanOutSubscribers(): Promise<number> {
    const reply: unknown = await observer.call('PUBSUB', 'NUMSUB', 'socket.io-request#/#');
    return Array.isArray(reply) ? Number(reply[1]) : 0;
  }

  beforeAll(async () => {
    redis = await new RedisContainer(redisImage()).start();
    redisAddress = `${redis.getHost()}:${String(redis.getMappedPort(6379))}`;
    observer = new Redis(redis.getConnectionUrl());
    // The observer loses Redis with the gateway, at the end; its reconnection errors say nothing.
    observer.on('error', () => undefined);
    for (const [name, value] of Object.entries(testEnvironment(redis.getConnectionUrl()))) {
      vi.stubEnv(name, value);
    }
    // The application module validates the environment when it is declared: import it only once
    // the environment is in place.
    const { loadConfig } = await import('@cadenway/nest-common');
    const { appConfigSchema } = await import('../src/config/app-config.js');
    config = loadConfig(appConfigSchema);
    ({ app, url } = await startApplication(config, logLines));
    server = app.getHttpServer();
  });

  afterAll(async () => {
    if (!appClosed) {
      await app.close();
    }
    observer.disconnect();
    if (!redisStopped) {
      await redis.stop();
    }
    vi.unstubAllEnvs();
  });

  it('answers the liveness route', async () => {
    await request(server).get('/health/live').expect(200);
  });

  it('is ready while Redis answers', async () => {
    expect(await readinessStatus(200)).toBe(200);

    const response: request.Response = await request(server).get('/health/ready');
    expect(response.body).toMatchObject({ status: 'ok', info: { redis: { status: 'up' } } });
  });

  it('accepts a long-polling preflight from the web application, with credentials', async () => {
    const response: request.Response = await request(server)
      .options(POLLING_HANDSHAKE)
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers.vary).toContain('Origin');
  });

  it('accepts a preflight of an HTTP route from the web application, with credentials', async () => {
    const response: request.Response = await request(server)
      .options('/health/ready')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toBe('GET,HEAD');
  });

  it('refuses a preflight from any other origin', async () => {
    for (const origin of REFUSED_ORIGINS) {
      for (const path of [POLLING_HANDSHAKE, '/health/ready']) {
        const response: request.Response = await request(server)
          .options(path)
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST');

        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
    }
  });

  it('lets a WebSocket handshake from the web application reach the gateway, which closes it', async () => {
    expect(await handshake(url, ALLOWED_ORIGIN)).toEqual({
      connected: true,
      reason: 'io server disconnect',
    });
  });

  it('refuses a WebSocket handshake from another origin or without one, before the gateway', async () => {
    for (const origin of [...REFUSED_ORIGINS, undefined]) {
      expect(await handshake(url, origin)).toEqual({ connected: false, reason: 'websocket error' });
    }
  });

  it('refuses a long-polling handshake from another origin with 403', async () => {
    const allowed: request.Response = await request(server)
      .get(POLLING_HANDSHAKE)
      .set('Origin', ALLOWED_ORIGIN);
    expect(allowed.status).toBe(200);
    expect(allowed.text).toMatch(/^0\{"sid":/u);

    for (const origin of REFUSED_ORIGINS) {
      const refused: request.Response = await request(server)
        .get(POLLING_HANDSHAKE)
        .set('Origin', origin);

      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ code: 4, message: 'Origin not allowed' });
    }
  });

  it('does not serve the Socket.IO client bundle', async () => {
    const response: request.Response = await request(server).get('/socket.io/socket.io.js');

    expect(response.status).not.toBe(200);
  });

  it('fans out through Redis, and a stopped instance closes both adapter connections', async () => {
    expect(await waitFor(fanOutSubscribers, 1)).toBe(1);
    expect(await adapterConnections('realtime-gateway-publisher')).toBe(1);
    expect(await adapterConnections('realtime-gateway-subscriber')).toBe(1);

    const second: { app: NestExpressApplication; url: string } = await startApplication(config, []);
    expect(await waitFor(fanOutSubscribers, 2)).toBe(2);
    expect(await adapterConnections('realtime-gateway-subscriber')).toBe(2);

    await second.app.close();
    expect(await waitFor(fanOutSubscribers, 1)).toBe(1);
    expect(await waitFor(() => adapterConnections('realtime-gateway-publisher'), 1)).toBe(1);
    expect(await waitFor(() => adapterConnections('realtime-gateway-subscriber'), 1)).toBe(1);
    expect(await waitFor(() => adapterConnections('realtime-gateway'), 1)).toBe(1);
  });

  it('exposes nothing of the request a client chose, and answers problem+json', async () => {
    const response: request.Response = await request(server)
      .get('/unknown')
      .set('Origin', ALLOWED_ORIGIN)
      .set('X-Request-Id', 'chosen-by-the-client');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 404, code: 'http.not-found' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('sets the security headers and hides the framework', async () => {
    const response: request.Response = await request(server).get('/health/live');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toBeDefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('trusts exactly one proxy hop', () => {
    const trusted: unknown = app.getHttpAdapter().getInstance().get('trust proxy');

    expect(trusted).toBe(1);
  });

  it('writes one JSON line per request, without the client request id', () => {
    const lines: Record<string, unknown>[] = logLines.map(
      (line: string) => JSON.parse(line) as Record<string, unknown>,
    );
    const completion: Record<string, unknown> | undefined = lines.find(
      (line: Record<string, unknown>) => line.status === 404,
    );

    expect(completion).toMatchObject({ service: 'realtime-gateway', method: 'GET', status: 404 });
    expect(JSON.stringify(lines)).not.toContain('chosen-by-the-client');
    expect(JSON.stringify(lines)).not.toContain('not-a-ticket');
  });

  it('reports Redis down on readiness once Redis stops, and stays alive', async () => {
    await redis.stop();
    redisStopped = true;

    expect(await readinessStatus(503)).toBe(503);

    const response: request.Response = await request(server).get('/health/ready');
    expect(response.body).toMatchObject({
      status: 'error',
      error: { redis: { status: 'down' } },
    });
    await request(server).get('/health/live').expect(200);
  });

  it('logs the outage once while the clients keep reconnecting', async () => {
    // Several reconnection attempts fail within this wait.
    await delay(1_500);

    const outages: string[] = logLines.filter((line: string) =>
      line.includes('Redis is unreachable'),
    );

    expect(outages).toHaveLength(1);
    expect(JSON.parse(outages[0] ?? '{}')).toMatchObject({ level: 'warn', context: 'Redis' });
    expect(outages[0]).not.toContain(redisAddress);
  });

  it('shuts down while Redis is down without an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const collect = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', collect);
    try {
      // Closing the Socket.IO server makes the adapter unsubscribe, a command that waits in the
      // offline queue of the subscriber until the shutdown drops it.
      await app.close();
      appClosed = true;
      await delay(500);
    } finally {
      process.off('unhandledRejection', collect);
    }

    expect(rejections).toEqual([]);
    expect(logLines.filter((line: string) => line.includes('Socket.IO adapter failed'))).toEqual(
      [],
    );
  });
});
