import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RedisPresenceSubscription } from '../../../../../connection/infrastructure/adapters/redis/connection/redis-presence-subscription.adapter.js';
import { RedisSocketRegistry } from '../../../../../connection/infrastructure/adapters/redis/connection/redis-socket-registry.adapter.js';
import type { PresenceConnection } from '../../../../application/models/presence/presence.model.js';
import { RedisPresenceStore } from './redis-presence-store.adapter.js';

const image =
  'redis:8.10.3-alpine@sha256:7958cfbb9d152f87dadfbc89f1b0b15938f0b81ff8982feb327476f4911935c3';
const organizationId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f15';
const otherOrganization = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f16';
const memberId = '019a7004-3b2c-7d4e-8f5a-6b7c8d9e0f17';

function socket(overrides: Partial<PresenceConnection> = {}): PresenceConnection {
  return {
    organizationId,
    memberId: randomUUID(),
    socketId: randomUUID(),
    sessionId: randomUUID(),
    sessionVersion: 1,
    expiresAt: Date.now() + 60_000,
    userId: randomUUID(),
    role: 'member',
    ...overrides,
  };
}

describe('Redis presence leases', () => {
  let container: StartedRedisContainer;
  let redis: Redis;
  let listener: Redis;
  let store: RedisPresenceStore;
  let registry: RedisSocketRegistry;
  const messages: { channel: string; payload: string }[] = [];

  beforeAll(async () => {
    container = await new RedisContainer(image).start();
    redis = new Redis(container.getConnectionUrl());
    listener = new Redis(container.getConnectionUrl());
    store = new RedisPresenceStore(redis);
    registry = new RedisSocketRegistry(redis);
    listener.on('message', (channel, payload) => messages.push({ channel, payload }));
    await listener.subscribe(`realtime:presence:org:${organizationId}`);
    await listener.subscribe(`realtime:presence:org:${otherOrganization}`);
  });

  afterAll(async () => {
    await listener.quit();
    await redis.quit();
    await container.stop();
  });

  it('delivers one common transition to each replica and limits it to its organization', async () => {
    const deliveries: { replica: string; organization: string; packet: unknown }[] = [];
    const createBridge = (replica: string): RedisPresenceSubscription =>
      new RedisPresenceSubscription(
        redis,
        (organization, packet) => {
          deliveries.push({ replica, organization, packet });
          return Promise.resolve();
        },
        () => () => undefined,
      );
    const first = createBridge('first');
    const second = createBridge('second');
    try {
      await vi.waitFor(() => {
        expect(first.ready).toBe(true);
        expect(second.ready).toBe(true);
      });
      const connection = socket();
      expect(await registry.register(connection.socketId, connection)).toBe(true);
      expect(await store.connect(connection)).toBe(true);
      await vi.waitFor(() => {
        expect(deliveries).toHaveLength(2);
      });
      expect(deliveries.map(({ organization }) => organization)).toEqual([
        organizationId,
        organizationId,
      ]);
      expect(deliveries[0]?.packet).toEqual(deliveries[1]?.packet);
      expect(deliveries[0]?.packet).toMatchObject({
        type: 'user.status-changed.v1',
        version: 1,
        data: { memberId: connection.memberId, status: 'online' },
      });
      await store.disconnect(connection);
    } finally {
      await first.onApplicationShutdown();
      await second.onApplicationShutdown();
    }
  });

  it('isolates organizations and aggregates sockets without revealing invisible status', async () => {
    const first = socket({ memberId });
    const second = { ...first, socketId: randomUUID() };
    const other = {
      ...first,
      socketId: randomUUID(),
      sessionId: randomUUID(),
      organizationId: otherOrganization,
    };
    for (const connection of [first, second, other]) {
      expect(await registry.register(connection.socketId, connection)).toBe(true);
    }
    expect(await store.connect(first)).toBe(true);
    expect(await store.connect(second)).toBe(true);
    expect(await store.connect(other)).toBe(true);
    expect(await store.set(first, 'invisible')).toBe(true);
    expect(await store.set(second, 'away')).toBe('limited');
    expect(await store.heartbeat(second)).toBe(true);
    await store.disconnect(first);
    await store.disconnect(second);
    expect(await store.set(other, 'away')).toBe(true);
    await delay(50);
    const firstMessages = messages
      .filter((message) => message.channel.endsWith(organizationId))
      .map((message) => JSON.parse(message.payload) as { memberId: string; status: string })
      .filter((message) => message.memberId === memberId);
    expect(firstMessages).toEqual([
      expect.objectContaining({ memberId, status: 'online' }) as unknown,
      expect.objectContaining({ memberId, status: 'offline' }) as unknown,
    ]);
    expect(messages.some((message) => message.payload.includes('invisible'))).toBe(false);
    expect(messages.filter((message) => message.channel.endsWith(otherOrganization))).toHaveLength(
      2,
    );
  });

  it('expires a session without allowing a heartbeat to revive it', async () => {
    const connection = socket({ expiresAt: Date.now() + 250 });
    expect(await registry.register(connection.socketId, connection)).toBe(true);
    expect(await store.connect(connection)).toBe(true);
    await delay(300);
    expect(await store.heartbeat(connection)).toBe(false);
    expect(await store.expire(500)).toBeGreaterThanOrEqual(0);
    await delay(25);
    const events = messages.map(
      (message) => JSON.parse(message.payload) as { memberId: string; status: string },
    );
    expect(
      events.filter((event) => event.memberId === connection.memberId).map((event) => event.status),
    ).toEqual(['online', 'offline']);
  });

  it('emits offline from a scheduled sweep when a client stops sending heartbeats', async () => {
    const connection = socket({ expiresAt: Date.now() + 250 });
    expect(await registry.register(connection.socketId, connection)).toBe(true);
    expect(await store.connect(connection)).toBe(true);
    await delay(300);
    expect(await store.expire(500)).toBeGreaterThanOrEqual(1);
    await delay(25);
    const events = messages.map(
      (message) => JSON.parse(message.payload) as { memberId: string; status: string },
    );
    expect(
      events.filter((event) => event.memberId === connection.memberId).map((event) => event.status),
    ).toEqual(['online', 'offline']);
  });

  it('binds presence to the exact verified socket identity', async () => {
    const connection = socket();
    expect(await store.connect(connection)).toBe(false);
    expect(await registry.register(connection.socketId, connection)).toBe(true);
    expect(await store.connect({ ...connection, userId: randomUUID() })).toBe(false);
    expect(await store.connect(connection)).toBe(true);
    await store.disconnect(connection);
  });

  const invalidations = {
    'session revocation': (connection: PresenceConnection) =>
      registry.markSessionRevoked(connection.sessionId, 2),
    'membership role change and revert': async (connection: PresenceConnection) => {
      await registry.markMembershipRole(connection.organizationId, connection.memberId, 2, 'admin');
      await registry.markMembershipRole(
        connection.organizationId,
        connection.memberId,
        3,
        'member',
      );
    },
    'tenant lease invalidation': (connection: PresenceConnection) =>
      registry.invalidateOrganizationLeases(connection.organizationId, randomUUID()),
  };

  it.each(Object.entries(invalidations))(
    'keeps revoked sockets from changing or publishing presence after %s',
    async (_name, invalidate) => {
      const active = socket();
      const pending = { ...active, socketId: randomUUID() };
      const fresh = { ...active, socketId: randomUUID(), sessionId: randomUUID() };
      expect(await registry.register(active.socketId, active)).toBe(true);
      expect(await registry.register(pending.socketId, pending)).toBe(true);
      expect(await store.connect(active)).toBe(true);
      expect(await store.set(active, 'away')).toBe(true);
      expect(await registry.readFence(active.socketId, active)).not.toBeNull();
      await invalidate(active);

      expect(await store.set(active, 'do-not-disturb')).toBe(false);
      expect(await store.heartbeat(active)).toBe(false);
      expect(await store.connect(pending)).toBe(false);
      await store.disconnect(active);
      expect(await registry.register(fresh.socketId, fresh)).toBe(true);
      expect(await store.connect(fresh)).toBe(true);

      await vi.waitFor(() => {
        const statuses = messages
          .map((message) => JSON.parse(message.payload) as { memberId: string; status: string })
          .filter((event) => event.memberId === active.memberId)
          .map((event) => event.status);
        expect(statuses).toEqual(['online', 'away', 'offline', 'away']);
      });
      await store.disconnect(fresh);
    },
  );
});
