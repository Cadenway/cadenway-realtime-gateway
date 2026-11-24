import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '@cadenway/nest-common';
import { EventPublisher, MessagingModule } from '@cadenway/nest-messaging';
import {
  COMMENT_CREATED_V1,
  eventSchemas,
  GIT_PR_OPENED_V1,
  LIST_ACCESS_CHANGED_V1,
  SESSION_REVOKED_V1,
  TASK_STATUS_CHANGED_V1,
  TASK_UPDATED_V1,
} from '@cadenway/contracts/events/realtime-gateway';
import {
  NOTIFICATION_CREATED_V1,
  REMINDER_DUE_V1,
  eventSchemas as notificationSchemas,
} from '@cadenway/contracts/events/notification-service';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
} from '@nats-io/jetstream';
import { connect as connectNats, type NatsConnection } from '@nats-io/transport-node';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { appConfigSchema, type AppConfig } from '../src/config/app-config.js';
import { createRealtimeApplication } from '../src/realtime-application.js';
import { ConnectionRecipients } from '../src/modules/connection/public/connection/connection-recipients.js';
import { relayInvalidationHandlers } from '../src/modules/relays/presentation/messaging/handlers/relay/relay-events.handler.js';
import {
  RealtimeUpstreams,
  listId,
  organizationId,
  otherOrganizationId,
  spaceId,
  taskId,
  taskKey,
  type TestSession,
} from './support/realtime-upstreams.fixture.js';

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
 * Constant NATS_USER
 *
 * @description
 * NATS user of the gateway, the one cadenway-ops declares and `nats/nats-server.conf` copies.
 *
 * @type {string}
 */
const NATS_USER = 'realtime-gateway';

/**
 * Constant NATS_CONFIG_PATH
 *
 * @description
 * Path of the broker configuration inside the NATS container, as in `compose.dev.yaml`.
 *
 * @type {string}
 */
const NATS_CONFIG_PATH = '/etc/nats/nats-server.conf';

/**
 * Interface BrokerConnection
 *
 * @description
 * What the monitoring endpoint of the broker (`/connz?auth=true&subs=true`) reports of one client
 * connection, as far as these tests read it.
 */
interface BrokerConnection {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Name the client announced, `realtime-gateway` for the gateway.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly name?: string;

  /**
   * Property authorized_user
   *
   * @description
   * NATS user the connection authenticated as.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly authorized_user?: string;

  /**
   * Property subscriptions_list
   *
   * @description
   * Subjects the connection subscribes to.
   *
   * @type {string[] | undefined}
   * @readonly
   */
  readonly subscriptions_list?: string[];
  // #endregion
}

/**
 * Function composeImage
 *
 * @description
 * Reads an image of `compose.dev.yaml`, so the tests run the images the workstation runs and the
 * pins Renovate updates live in one file.
 *
 * @param {'redis' | 'nats'} repository - Image repository.
 * @returns {string} The image reference, tag and digest.
 * @throws {Error} When `compose.dev.yaml` names no image of that repository.
 */
function composeImage(repository: 'redis' | 'nats'): string {
  const compose: string = readFileSync(new URL('../compose.dev.yaml', import.meta.url), 'utf8');
  const pattern = new RegExp(String.raw`^\s*image:\s*(${repository}:\S+)\s*$`, 'mu');
  const image: string | undefined = pattern.exec(compose)?.[1];
  if (image === undefined) {
    throw new Error(`compose.dev.yaml names no ${repository} image.`);
  }
  return image;
}

/**
 * Function brokerPassword
 *
 * @description
 * Generates a NATS password for one run: letters and digits starting with a letter, the only
 * values the broker reads safely from its configuration. No password of a test is committed.
 *
 * @returns {string} The password.
 */
function brokerPassword(): string {
  return `p${randomBytes(12).toString('hex')}`;
}

/**
 * Function startBroker
 *
 * @description
 * Starts the broker of `compose.dev.yaml` in a disposable container: its image, its
 * `nats/nats-server.conf` (the users `realtime-gateway` and `admin`, with the permissions and the
 * inbox prefix rule of cadenway-ops) and passwords generated for this run.
 *
 * @param {string} adminPassword - Password of `admin`.
 * @param {string} gatewayPassword - Password of `realtime-gateway`.
 * @returns {Promise<StartedTestContainer>} The running broker, client and monitoring ports exposed.
 */
async function startBroker(
  adminPassword: string,
  gatewayPassword: string,
): Promise<StartedTestContainer> {
  return new GenericContainer(composeImage('nats'))
    .withCopyFilesToContainer([
      {
        source: fileURLToPath(new URL('../nats/nats-server.conf', import.meta.url)),
        target: NATS_CONFIG_PATH,
      },
    ])
    .withEnvironment({
      NATS_ADMIN_PASSWORD: adminPassword,
      REALTIME_GATEWAY_NATS_PASSWORD: gatewayPassword,
    })
    .withCommand(['--config', NATS_CONFIG_PATH])
    .withExposedPorts(4222, 8222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/u))
    .start();
}

/**
 * Function createStreams
 *
 * @description
 * Creates the streams as cadenway-ops does, with the `admin` user: the gateway may not create one
 * and refuses to start without `EVENTS`. `manageStreams` of `@cadenway/nest-messaging` applies the
 * settings of cadenway-ops to `EVENTS`, `EVENTS_RESTRICTED` and `EVENTS_DLQ`.
 *
 * @param {string} servers - Address of the broker.
 * @param {string} adminPassword - Password of `admin`.
 * @returns {Promise<void>} Resolves once the streams exist and the connection is closed.
 */
async function createStreams(servers: string, adminPassword: string): Promise<void> {
  const context: INestApplicationContext = await NestFactory.createApplicationContext(
    MessagingModule.forRoot({
      service: 'stream-setup',
      servers,
      user: 'admin',
      password: adminPassword,
      manageStreams: true,
    }),
    { logger: false },
  );
  await context.close();
  const nc = await connectNats({ servers, user: 'admin', pass: adminPassword });
  try {
    const manager = await jetstreamManager(nc);
    const subjects = Object.values(relayInvalidationHandlers).flatMap((handler) =>
      ['MAX_DELIVERIES', 'MSG_TERMINATED'].map(
        (kind) => `$JS.EVENT.ADVISORY.CONSUMER.${kind}.EVENTS.realtime-gateway__${handler}`,
      ),
    );
    await manager.streams.add({
      name: 'REALTIME_AUTHORIZATION_ADVISORIES',
      subjects,
      storage: StorageType.File,
      retention: RetentionPolicy.Limits,
      discard: DiscardPolicy.Old,
      max_msgs: 1,
      max_age: 0,
      max_bytes: -1,
      max_msg_size: -1,
      max_msgs_per_subject: -1,
    });
  } finally {
    await nc.close();
  }
}

/**
 * Function testEnvironment
 *
 * @description
 * Environment of the gateway under test: the disposable Redis and broker, a signing key generated
 * for this run (no key is ever committed) and service addresses nothing listens on, since nothing
 * calls a service yet.
 *
 * @param {string} redisUrl - Address of the disposable Redis.
 * @param {string} natsUrl - Address of the disposable broker.
 * @param {string} natsPassword - Password of the NATS user of the gateway.
 * @returns {Record<string, string>} The variables to stub.
 */
function testEnvironment(
  redisUrl: string,
  natsUrl: string,
  natsPassword: string,
): Record<string, string> {
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
    ORGANIZATION_SERVICE_URL: 'http://127.0.0.1:1',
    TASK_SERVICE_URL: 'http://127.0.0.1:1',
    NATS_URL: natsUrl,
    NATS_USER,
    NATS_PASSWORD: natsPassword,
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
 * Polls a probe until it returns the expected value or the time runs out: Redis and NATS
 * connections and subscriptions settle a moment after the application starts or stops.
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
  const gatewayPassword: string = brokerPassword();
  let redis: StartedRedisContainer;
  let redisStopped = false;
  let redisAddress: string;
  let nats: StartedTestContainer;
  let natsStopped = false;
  let natsMonitoring: string;
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

  /**
   * Function brokerConnections
   *
   * @description
   * Reads the client connections of the broker from its monitoring endpoint, with their
   * authenticated user and their subscriptions.
   *
   * @returns {Promise<BrokerConnection[]>} One entry per client connection.
   */
  async function brokerConnections(): Promise<BrokerConnection[]> {
    const response: Response = await fetch(`${natsMonitoring}/connz?auth=true&subs=true`);
    const body = (await response.json()) as { connections?: BrokerConnection[] };
    return body.connections ?? [];
  }

  beforeAll(async () => {
    const adminPassword: string = brokerPassword();
    [redis, nats] = await Promise.all([
      new RedisContainer(composeImage('redis')).start(),
      startBroker(adminPassword, gatewayPassword),
    ]);
    redisAddress = `${redis.getHost()}:${String(redis.getMappedPort(6379))}`;
    const natsUrl = `nats://${nats.getHost()}:${String(nats.getMappedPort(4222))}`;
    natsMonitoring = `http://${nats.getHost()}:${String(nats.getMappedPort(8222))}`;
    await createStreams(natsUrl, adminPassword);
    observer = new Redis(redis.getConnectionUrl());
    // The observer loses Redis with the gateway, at the end; its reconnection errors say nothing.
    observer.on('error', () => undefined);
    // `ConfigModule` validates the environment of the process again when the application is
    // created, so the variables are stubbed as well as passed.
    for (const [name, value] of Object.entries(
      testEnvironment(redis.getConnectionUrl(), natsUrl, gatewayPassword),
    )) {
      vi.stubEnv(name, value);
    }
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
    if (!natsStopped) {
      await nats.stop();
    }
    vi.unstubAllEnvs();
  });

  it('answers the liveness route', async () => {
    await request(server).get('/health/live').expect(200);
  });

  it('is ready while Redis and NATS answer', async () => {
    expect(await readinessStatus(200)).toBe(200);

    const response: request.Response = await request(server).get('/health/ready');
    expect(response.body).toMatchObject({
      status: 'ok',
      info: { redis: { status: 'up' }, nats: { status: 'up' } },
    });
  });

  it('connects to NATS as its own user and receives its replies under its own inbox prefix', async () => {
    const gateway: BrokerConnection | undefined = (await brokerConnections()).find(
      (connection: BrokerConnection) => connection.name === 'realtime-gateway',
    );

    expect(gateway?.authorized_user).toBe(NATS_USER);
    expect(gateway?.subscriptions_list?.length).toBeGreaterThan(0);
    expect(
      gateway?.subscriptions_list?.every((subject: string) =>
        subject.startsWith(`_INBOX.${NATS_USER}.`),
      ),
    ).toBe(true);
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

  it('drops a pending Engine.IO session and restores subscriptions after Redis subscriber loss', async () => {
    const first = await request(server).get(POLLING_HANDSHAKE).set('Origin', ALLOWED_ORIGIN);
    expect(first.status).toBe(200);
    const admitted = JSON.parse(first.text.slice(1)) as { sid: string };
    expect(admitted.sid).toBeTruthy();

    const client = String(await observer.call('CLIENT', 'LIST'))
      .split('\n')
      .find((line) => line.includes(' name=realtime-gateway-subscriber '));
    const subscriberId = /^id=(\d+) /u.exec(client ?? '')?.[1];
    expect(subscriberId).toBeDefined();
    expect(await observer.call('CLIENT', 'KILL', 'ID', String(subscriberId))).toBe(1);

    expect(await waitFor(fanOutSubscribers, 1)).toBe(1);
    expect(await readinessStatus(200)).toBe(200);
    await request(server)
      .get(`${POLLING_HANDSHAKE}&sid=${encodeURIComponent(admitted.sid)}`)
      .set('Origin', ALLOWED_ORIGIN)
      .expect(400, { code: 1, message: 'Session ID unknown' });
    const fresh = await request(server).get(POLLING_HANDSHAKE).set('Origin', ALLOWED_ORIGIN);
    expect(fresh.status).toBe(200);
    expect((JSON.parse(fresh.text.slice(1)) as { sid: string }).sid).not.toBe(admitted.sid);
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
    expect(JSON.stringify(lines)).not.toContain(gatewayPassword);
  });

  it('reports NATS down on readiness once NATS stops, and stays alive', async () => {
    await nats.stop();
    natsStopped = true;

    expect(await readinessStatus(503)).toBe(503);

    const response: request.Response = await request(server).get('/health/ready');
    expect(response.body).toMatchObject({
      status: 'error',
      info: { redis: { status: 'up' } },
      error: { nats: { status: 'down' } },
    });
    await request(server).get('/health/live').expect(200);
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

  it('logs the outage once for its three connections while they keep reconnecting', async () => {
    // Several reconnection attempts fail within this wait.
    await delay(1_500);

    const outages: string[] = logLines.filter((line: string) => line.includes('redis unreachable'));

    expect(outages).toHaveLength(1);
    expect(JSON.parse(outages[0] ?? '{}')).toMatchObject({
      level: 'warn',
      context: 'Redis',
      connection: 'realtime-gateway',
      msg: 'redis unreachable',
    });
    expect(outages[0]).not.toContain(redisAddress);
  });

  it('answers 503 on readiness from the start of the stop, and stops without an unhandled rejection while Redis and NATS are down', async () => {
    const rejections: unknown[] = [];
    const collect = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', collect);
    try {
      // Closing the Socket.IO server makes the adapter unsubscribe, a command that waits in the
      // offline queue of the subscriber until the shutdown drops it. The listener stays open for
      // the shutdown delay, which is when the probes below run.
      const closing: Promise<void> = app.close();
      const shutdownState: string | undefined = await waitFor(
        async () =>
          (
            (await request(server).get('/health/ready')).body as {
              error?: { shutdown?: { message?: string } };
            }
          ).error?.shutdown?.message,
        'shutting down',
      );
      const ready: request.Response = await request(server).get('/health/ready');
      const live: request.Response = await request(server).get('/health/live');
      await closing;
      appClosed = true;
      await delay(500);

      expect(shutdownState).toBe('shutting down');
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({
        status: 'error',
        info: {},
        error: { shutdown: { status: 'down', message: 'shutting down' } },
        details: { shutdown: { status: 'down', message: 'shutting down' } },
      });
      expect(live.status).toBe(200);
    } finally {
      process.off('unhandledRejection', collect);
    }

    expect(rejections).toEqual([]);
    expect(logLines.filter((line: string) => line.includes('redis command failed'))).toEqual([]);
  });
});

describe('realtime relay across two instances', () => {
  let redis: StartedRedisContainer;
  let nats: StartedTestContainer;
  let upstream: RealtimeUpstreams;
  let publisherContext: INestApplicationContext;
  let admin: NatsConnection;
  let config: AppConfig;
  let first: { app: NestExpressApplication; url: string };
  let second: { app: NestExpressApplication; url: string };
  const sockets: Socket[] = [];
  const cleanup: (() => Promise<unknown>)[] = [];
  const alphaId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31';
  const betaId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b32';
  const deniedId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b33';

  function session(userId: string, organization: string, lifetime = 60_000): TestSession {
    return {
      userId,
      organizationId: organization,
      memberId: userId,
      sessionId: userId,
      sessionVersion: 1,
      role: 'member',
      sessionExpiresAt: new Date(Date.now() + lifetime).toISOString(),
    };
  }

  async function connect(url: string, token: string): Promise<Socket> {
    const socket = io(url, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token },
      extraHeaders: { Origin: ALLOWED_ORIGIN },
    });
    sockets.push(socket);
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Socket did not become ready.'));
      }, 10_000);
      socket.once('hello', () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once('connect_error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.once('disconnect', () => {
        clearTimeout(timeout);
        reject(new Error('Socket closed before readiness.'));
      });
    });
    socket.connect();
    await ready;
    return socket;
  }

  async function join(socket: Socket): Promise<unknown> {
    return socket
      .timeout(5_000)
      .emitWithAck('room:join', { kind: 'task', taskKey }) as Promise<unknown>;
  }

  beforeAll(async () => {
    const adminPassword = brokerPassword();
    const gatewayPassword = brokerPassword();
    redis = await new RedisContainer(composeImage('redis')).start();
    cleanup.push(() => redis.stop());
    nats = await startBroker(adminPassword, gatewayPassword);
    cleanup.push(() => nats.stop());
    const natsUrl = `nats://${nats.getHost()}:${String(nats.getMappedPort(4222))}`;
    await createStreams(natsUrl, adminPassword);
    const env = testEnvironment(redis.getConnectionUrl(), natsUrl, gatewayPassword);
    upstream = await RealtimeUpstreams.start(env.INTERNAL_TOKEN_PRIVATE_JWK ?? '');
    cleanup.push(() => upstream.close());
    env.IDENTITY_SERVICE_URL = upstream.url;
    env.ORGANIZATION_SERVICE_URL = upstream.url;
    env.TASK_SERVICE_URL = upstream.url;
    env.REALTIME_GIT_RELAYS_ENABLED = 'true';
    env.REALTIME_PERSONAL_NOTICES_ENABLED = 'true';
    env.REALTIME_PAGED_RECIPIENTS_ENABLED = 'true';
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    config = loadConfig(appConfigSchema);
    admin = await connectNats({ servers: natsUrl, user: 'admin', pass: adminPassword });
    cleanup.push(() => admin.close());
    publisherContext = await NestFactory.createApplicationContext(
      MessagingModule.forRoot({
        service: 'realtime-test-publisher',
        servers: natsUrl,
        user: 'admin',
        password: adminPassword,
        manageStreams: false,
      }),
      { logger: false },
    );
    cleanup.push(() => publisherContext.close());
    first = await startApplication(config, []);
    cleanup.push(() => first.app.close());
    second = await startApplication(config, []);
    cleanup.push(() => second.app.close());
    await waitFor(
      async () => (await request(first.app.getHttpServer() as App).get('/health/ready')).status,
      200,
    );
    await waitFor(
      async () => (await request(second.app.getHttpServer() as App).get('/health/ready')).status,
      200,
    );
  }, 120_000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    try {
      for (const close of cleanup.reverse()) await close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('isolates organizations, rechecks task access and closes a revoked session', async () => {
    const alphaTicket = 'a'.repeat(43);
    const betaTicket = 'b'.repeat(43);
    const deniedTicket = 'c'.repeat(43);
    const otherTicket = 'd'.repeat(43);
    upstream.issue(alphaTicket, session(alphaId, organizationId), true);
    upstream.issue(betaTicket, session(betaId, organizationId), true);
    upstream.issue(deniedTicket, session(deniedId, organizationId), false);
    upstream.issue(
      otherTicket,
      session('019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b34', otherOrganizationId),
      true,
    );
    const [alpha, beta, denied, other] = await Promise.all([
      connect(first.url, alphaTicket),
      connect(second.url, betaTicket),
      connect(first.url, deniedTicket),
      connect(second.url, otherTicket),
    ]);
    expect(await join(alpha)).toEqual({ ok: true });
    expect(await join(beta)).toEqual({ ok: true });
    expect(await join(denied)).toEqual({ ok: false, code: 'room.not-found' });
    expect(await join(other)).toEqual({ ok: false, code: 'room.not-found' });
    const recipients = await first.app.get(ConnectionRecipients).readTask(organizationId, taskKey);
    expect(recipients.map((recipient) => recipient.session.userId).sort()).toEqual(
      [alphaId, betaId].sort(),
    );

    const received = {
      alpha: [] as unknown[],
      beta: [] as unknown[],
      denied: [] as unknown[],
      other: [] as unknown[],
    };
    const collect = (target: unknown[], packet: unknown): void => {
      const envelope = packet as { type?: string };
      if (envelope.type !== 'user.status-changed.v1') target.push(packet);
    };
    alpha.on('change', (packet: unknown) => {
      collect(received.alpha, packet);
    });
    beta.on('change', (packet: unknown) => {
      collect(received.beta, packet);
    });
    denied.on('change', (packet: unknown) => {
      collect(received.denied, packet);
    });
    other.on('change', (packet: unknown) => {
      collect(received.other, packet);
    });
    const publisher = publisherContext.get(EventPublisher);
    const sent = await publisher.publish(eventSchemas, TASK_STATUS_CHANGED_V1, {
      organizationId,
      actor: { type: 'user', id: alphaId },
      version: 2,
      key: taskKey,
      spaceId,
      listId,
      parentKey: null,
      name: 'Fixture task',
      status: 'review',
      previousStatus: 'progress',
      cancelReason: null,
      cancelNote: null,
      priority: 'haute',
      assigneeIds: [],
      dueDate: null,
      startDate: null,
      estimateMinutes: null,
      labels: [],
      completedAt: null,
    });
    expect(await waitFor(() => Promise.resolve(received.alpha.length), 1)).toBe(1);
    expect(await waitFor(() => Promise.resolve(received.beta.length), 1)).toBe(1);
    expect(received.alpha[0]).toMatchObject({
      id: sent.id,
      type: TASK_STATUS_CHANGED_V1,
      data: { taskId, changed: ['status'] },
    });
    expect(received.beta[0]).toEqual(received.alpha[0]);
    expect(received.denied).toEqual([]);
    expect(received.other).toEqual([]);
    expect(upstream.taskChecks).toBeGreaterThanOrEqual(4);

    const updated = await publisher.publish(eventSchemas, TASK_UPDATED_V1, {
      organizationId,
      actor: { type: 'user', id: alphaId },
      version: 3,
      key: taskKey,
      spaceId,
      listId,
      parentKey: null,
      name: 'Updated fixture task',
      status: 'review',
      cancelReason: null,
      priority: 'haute',
      assigneeIds: [],
      dueDate: null,
      startDate: null,
      estimateMinutes: null,
      labels: [],
      completedAt: null,
      changed: ['name'],
    });
    expect(await waitFor(() => Promise.resolve(received.alpha.length), 2)).toBe(2);
    expect(await waitFor(() => Promise.resolve(received.beta.length), 2)).toBe(2);
    expect(received.alpha[1]).toMatchObject({
      id: updated.id,
      type: TASK_UPDATED_V1,
      data: { taskId, changed: ['name'] },
    });

    const commentId = '019a7003-4d5e-7f6a-8b9c-0d1e2f3a4b01';
    const comment = await publisher.publish(eventSchemas, COMMENT_CREATED_V1, {
      organizationId,
      actor: { type: 'user', id: alphaId },
      version: 3,
      key: taskKey,
      spaceId,
      listId,
      commentId,
      commentVersion: 1,
      mentionedUserIds: [],
      watcherIds: [],
    });
    expect(await waitFor(() => Promise.resolve(received.alpha.length), 3)).toBe(3);
    expect(await waitFor(() => Promise.resolve(received.beta.length), 3)).toBe(3);
    expect(received.beta[2]).toMatchObject({
      id: comment.id,
      type: COMMENT_CREATED_V1,
      data: { taskId, commentId },
    });

    const hold = upstream.holdTask(alphaId);
    const pending = await publisher.publish(eventSchemas, COMMENT_CREATED_V1, {
      organizationId,
      actor: { type: 'user', id: betaId },
      version: 4,
      key: taskKey,
      spaceId,
      listId,
      commentId,
      commentVersion: 2,
      mentionedUserIds: [],
      watcherIds: [],
    });
    await Promise.race([
      hold.entered,
      delay(5_000).then(() => {
        throw new Error('The pending Task authorization was not requested.');
      }),
    ]);
    const revoked = new Promise<void>((resolve) =>
      alpha.once('disconnect', () => {
        resolve();
      }),
    );
    await publisher.publish(eventSchemas, SESSION_REVOKED_V1, {
      organizationId: null,
      actor: { type: 'user', id: alphaId },
      version: 2,
      sessionId: alphaId,
      userId: alphaId,
    });
    try {
      await Promise.race([
        revoked,
        delay(10_000).then(() => {
          throw new Error('Revocation was not delivered.');
        }),
      ]);
    } finally {
      hold.release();
    }
    expect(alpha.connected).toBe(false);
    expect(beta.connected).toBe(true);
    expect(await waitFor(() => Promise.resolve(received.beta.length), 4)).toBe(4);
    expect(received.beta[3]).toMatchObject({ id: pending.id });

    await expect(connect(first.url, alphaTicket)).rejects.toThrow(
      'Socket closed before readiness.',
    );
    const next = await publisher.publish(eventSchemas, COMMENT_CREATED_V1, {
      organizationId,
      actor: { type: 'user', id: betaId },
      version: 5,
      key: taskKey,
      spaceId,
      listId,
      commentId,
      commentVersion: 3,
      mentionedUserIds: [],
      watcherIds: [],
    });
    expect(await waitFor(() => Promise.resolve(received.beta.length), 5)).toBe(5);
    expect(received.beta[4]).toMatchObject({ id: next.id });
    await delay(300);
    expect(received.alpha).toHaveLength(3);
  }, 40_000);

  it('relays a Git link once to the authorized organization and rejects stale placement', async () => {
    const readerId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b41';
    const outsiderId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b42';
    upstream.issue('g'.repeat(43), session(readerId, organizationId), true);
    upstream.issue('h'.repeat(43), session(outsiderId, otherOrganizationId), true);
    const [reader, outsider] = await Promise.all([
      connect(first.url, 'g'.repeat(43)),
      connect(second.url, 'h'.repeat(43)),
    ]);
    expect(await join(reader)).toEqual({ ok: true });
    expect(await join(outsider)).toEqual({ ok: false, code: 'room.not-found' });
    const received: unknown[] = [];
    const foreign: unknown[] = [];
    reader.on('change', (packet: unknown) => {
      if ((packet as { type?: string }).type === 'git.links-changed.v1') received.push(packet);
    });
    outsider.on('change', (packet: unknown) => {
      if ((packet as { type?: string }).type === 'git.links-changed.v1') foreign.push(packet);
    });

    const publisher = publisherContext.get(EventPublisher);
    const payload = eventSchemas[GIT_PR_OPENED_V1].parse({
      id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d50',
      occurredAt: '2026-11-08T10:41:00Z',
      organizationId,
      actor: { type: 'git', id: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01' },
      version: 1,
      taskKey,
      spaceId,
      listId,
      gitLinkId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03',
      changed: ['state'],
    });
    const event = {
      name: GIT_PR_OPENED_V1,
      subject: 'evt.git.pr-opened.v1',
      stream: 'EVENTS',
      payload,
      traceparent: null,
    };
    const published = await publisher.publishEnvelope(event);
    expect(published.duplicate).toBe(false);
    expect(await waitFor(() => Promise.resolve(received.length), 1)).toBe(1);
    expect(received[0]).toEqual({
      id: payload.id,
      type: 'git.links-changed.v1',
      at: payload.occurredAt,
      version: 1,
      data: { taskId },
    });
    expect((await publisher.publishEnvelope(event)).duplicate).toBe(true);

    const checksBeforeStale = upstream.taskChecks;
    const stalePayload = eventSchemas[GIT_PR_OPENED_V1].parse({
      ...payload,
      id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d51',
      listId: '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f13',
    });
    await publisher.publishEnvelope({
      ...event,
      payload: stalePayload,
    });
    await vi.waitFor(
      () => {
        expect(upstream.taskChecks).toBeGreaterThan(checksBeforeStale);
      },
      { timeout: 10_000, interval: 100 },
    );
    await delay(300);
    expect(received).toHaveLength(1);
    expect(foreign).toEqual([]);
  }, 40_000);

  it('keeps a same-tenant connection without a subscription to the changed list live', async () => {
    const subscriberId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b54';
    const observerId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b55';
    const subscriberTicket = 's'.repeat(43);
    const observerTicket = 't'.repeat(43);
    upstream.issue(subscriberTicket, session(subscriberId, organizationId), true);
    upstream.issue(observerTicket, session(observerId, organizationId), true);
    const [subscriber, observer] = await Promise.all([
      connect(first.url, subscriberTicket),
      connect(second.url, observerTicket),
    ]);
    expect(await join(subscriber)).toEqual({ ok: true });

    const publisher = publisherContext.get(EventPublisher);
    await publisher.publish(eventSchemas, LIST_ACCESS_CHANGED_V1, {
      organizationId,
      actor: { type: 'user', id: subscriberId },
      version: 2,
      listId,
      spaceId,
      organizationAccess: false,
      grants: [],
      changed: ['organizationAccess'],
      changedUserIds: [],
    });
    await vi.waitFor(
      () => {
        expect(subscriber.connected).toBe(false);
      },
      { interval: 250, timeout: 10_000 },
    );
    expect(observer.connected).toBe(true);
    await expect(observer.timeout(2_000).emitWithAck('presence:heartbeat', {})).resolves.toEqual({
      ok: true,
    });
    observer.disconnect();
  });

  it('closes an existing socket after loss of its SAML source membership without a broker event', async () => {
    const userId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b52';
    const token = 'u'.repeat(43);
    upstream.issue(
      token,
      {
        ...session(userId, organizationId),
        samlSourceMembership: {
          organizationId: otherOrganizationId,
          memberId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b53',
        },
      },
      true,
    );
    const connected = await connect(first.url, token);
    upstream.revokeMembership(otherOrganizationId, userId);
    await vi.waitFor(
      () => {
        expect(connected.connected).toBe(false);
      },
      {
        interval: 250,
        timeout: 23_000,
      },
    );
  }, 30_000);

  it('relays personal notices only to the named account in its organization when visible', async () => {
    const recipientId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b51';
    const colleagueId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b52';
    const hiddenId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b53';
    upstream.issue('n'.repeat(43), session(recipientId, organizationId), true);
    upstream.issue('o'.repeat(43), session(recipientId, organizationId), true);
    upstream.issue('p'.repeat(43), session(colleagueId, organizationId), true);
    upstream.issue('q'.repeat(43), session(hiddenId, organizationId), false);
    upstream.issue(
      'r'.repeat(43),
      {
        ...session(recipientId, otherOrganizationId),
        sessionId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b54',
      },
      true,
    );
    const [onFirst, onSecond, colleague, hidden, otherTenant] = await Promise.all([
      connect(first.url, 'n'.repeat(43)),
      connect(second.url, 'o'.repeat(43)),
      connect(first.url, 'p'.repeat(43)),
      connect(second.url, 'q'.repeat(43)),
      connect(first.url, 'r'.repeat(43)),
    ]);
    const personal = (socket: Socket): unknown[] => {
      const packets: unknown[] = [];
      socket.on('change', (packet: unknown) => {
        const type = (packet as { type?: string }).type;
        if (type === NOTIFICATION_CREATED_V1 || type === REMINDER_DUE_V1) packets.push(packet);
      });
      return packets;
    };
    const received = {
      first: personal(onFirst),
      second: personal(onSecond),
      colleague: personal(colleague),
      hidden: personal(hidden),
      otherTenant: personal(otherTenant),
    };
    const publisher = publisherContext.get(EventPublisher);
    const actor = { type: 'system', id: 'notification-service' } as const;

    const created = await publisher.publish(notificationSchemas, NOTIFICATION_CREATED_V1, {
      organizationId,
      actor,
      version: 1,
      notificationId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e11',
      recipientId,
      subject: { kind: 'task-key', taskKey },
      createdAt: '2026-11-08T10:40:00Z',
    });
    expect(await waitFor(() => Promise.resolve(received.first.length), 1)).toBe(1);
    expect(await waitFor(() => Promise.resolve(received.second.length), 1)).toBe(1);
    expect(received.first[0]).toEqual({
      id: created.id,
      type: NOTIFICATION_CREATED_V1,
      at: expect.any(String) as unknown,
      version: 1,
      data: {},
    });
    expect(received.second[0]).toEqual(received.first[0]);

    const reminderId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e12';
    const due = await publisher.publish(notificationSchemas, REMINDER_DUE_V1, {
      organizationId,
      actor,
      version: 2,
      reminderId,
      userId: recipientId,
      taskId,
    });
    expect(await waitFor(() => Promise.resolve(received.first.length), 2)).toBe(2);
    expect(received.first[1]).toEqual({
      id: due.id,
      type: REMINDER_DUE_V1,
      at: expect.any(String) as unknown,
      version: 2,
      data: { reminderId, taskId },
    });

    const checksBeforeHidden = upstream.taskChecks;
    await publisher.publish(notificationSchemas, REMINDER_DUE_V1, {
      organizationId,
      actor,
      version: 2,
      reminderId,
      userId: hiddenId,
      taskId,
    });
    await vi.waitFor(
      () => {
        expect(upstream.taskChecks).toBeGreaterThan(checksBeforeHidden);
      },
      { timeout: 10_000, interval: 100 },
    );
    const receipt = await publisher.publish(notificationSchemas, NOTIFICATION_CREATED_V1, {
      organizationId,
      actor,
      version: 1,
      notificationId: '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e13',
      recipientId: hiddenId,
      subject: null,
      createdAt: '2026-11-08T10:42:00Z',
    });
    expect(await waitFor(() => Promise.resolve(received.hidden.length), 1)).toBe(1);
    expect(received.hidden[0]).toMatchObject({ id: receipt.id, data: {} });
    await delay(300);
    expect(received.first).toHaveLength(2);
    expect(received.second).toHaveLength(2);
    expect(received.colleague).toEqual([]);
    expect(received.otherTenant).toEqual([]);
    expect(received.hidden).toHaveLength(1);
  }, 40_000);

  it('answers a presence snapshot of the caller organization only', async () => {
    const watcherId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b61';
    const awayId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b62';
    const foreignId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b63';
    upstream.issue('s'.repeat(43), session(watcherId, organizationId), true);
    upstream.issue('t'.repeat(43), session(awayId, organizationId), true);
    upstream.issue('u'.repeat(43), session(foreignId, otherOrganizationId), true);
    const watcher = await connect(first.url, 's'.repeat(43));
    const away = await connect(second.url, 't'.repeat(43));
    await connect(first.url, 'u'.repeat(43));
    expect(await away.timeout(5_000).emitWithAck('presence:set', { status: 'away' })).toEqual({
      ok: true,
    });

    const page = (await watcher.timeout(5_000).emitWithAck('presence:list', {})) as {
      ok: boolean;
      status: string;
      members: { memberId: string; status: string }[];
      nextCursor: string | null;
    };

    expect(page).toMatchObject({ ok: true, status: 'online', nextCursor: null });
    expect(page.members).toEqual(
      expect.arrayContaining([
        { memberId: watcherId, status: 'online' },
        { memberId: awayId, status: 'away' },
      ]),
    );
    expect(page.members.some(({ memberId }) => memberId === foreignId)).toBe(false);
    expect(await watcher.timeout(5_000).emitWithAck('presence:list', {})).toEqual({
      ok: false,
      code: 'realtime.unavailable',
    });
    expect(await watcher.timeout(5_000).emitWithAck('presence:list', { cursor: awayId })).toEqual({
      ok: false,
      code: 'request.invalid',
    });
    expect(watcher.connected).toBe(true);
  }, 20_000);

  it('publishes offline when the last presence lease expires', async () => {
    const observerId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b35';
    const transientId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b36';
    upstream.issue('e'.repeat(43), session(observerId, organizationId), true);
    upstream.issue('f'.repeat(43), session(transientId, organizationId, 5_000), true);
    const observer = await connect(first.url, 'e'.repeat(43));
    const notices: unknown[] = [];
    observer.on('change', (packet: unknown) => notices.push(packet));
    const transient = await connect(second.url, 'f'.repeat(43));
    expect(await waitFor(() => Promise.resolve(notices.length > 0), true)).toBe(true);
    await new Promise<void>((resolve) =>
      transient.once('disconnect', () => {
        resolve();
      }),
    );
    expect(
      await waitFor(
        () =>
          Promise.resolve(
            notices.some((notice) => {
              const packet = notice as {
                type?: string;
                data?: { memberId?: string; status?: string };
              };
              return (
                packet.type === 'user.status-changed.v1' &&
                packet.data?.memberId === transientId &&
                packet.data.status === 'offline'
              );
            }),
          ),
        true,
      ),
    ).toBe(true);
  }, 20_000);

  it('closes both instances on a retained native terminal advisory and refuses after restart', async () => {
    const firstId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b37';
    const secondId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b38';
    upstream.issue('g'.repeat(43), session(firstId, organizationId), true);
    upstream.issue('h'.repeat(43), session(secondId, organizationId), true);
    const [firstSocket, secondSocket] = await Promise.all([
      connect(first.url, 'g'.repeat(43)),
      connect(second.url, 'h'.repeat(43)),
    ]);
    const firstClosed = new Promise<void>((resolve) =>
      firstSocket.once('disconnect', () => {
        resolve();
      }),
    );
    const secondClosed = new Promise<void>((resolve) =>
      secondSocket.once('disconnect', () => {
        resolve();
      }),
    );
    // An invalid event makes the real kit consumer terminate its delivery; NATS generates the advisory.
    await jetstream(admin).publish('evt.session.revoked.v1', new TextEncoder().encode('{'));
    const manager = await jetstreamManager(admin);
    const stream = 'REALTIME_AUTHORIZATION_ADVISORIES';
    expect(await waitFor(async () => (await manager.streams.info(stream)).state.messages, 1)).toBe(
      1,
    );
    const terminal = await manager.streams.getMessage(stream, { seq: 1 });
    expect(terminal?.subject).toBe(
      '$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.EVENTS.realtime-gateway__relay-session-revoked',
    );
    await Promise.race([
      Promise.all([firstClosed, secondClosed]),
      delay(10_000).then(() => {
        throw new Error('Both instances did not close their sockets after the terminal advisory.');
      }),
    ]);
    expect(firstSocket.connected).toBe(false);
    expect(secondSocket.connected).toBe(false);
    await first.app.close();
    first = await startApplication(config, []);
    upstream.issue('i'.repeat(43), session(firstId, organizationId), true);
    await expect(connect(first.url, 'i'.repeat(43))).rejects.toThrow();
    expect((await manager.streams.info(stream)).state.messages).toBe(1);
  }, 30_000);
});
