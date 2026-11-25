import { ResilientRedisClient } from '@cadenway/nest-common/redis';
import { metrics } from '@opentelemetry/api';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RealtimeAdmissionGates } from '../../../../../../infrastructure/redis/realtime-admission-gates.js';
import type { RealtimeRoom } from '../../../../application/models/connection/realtime-room.model.js';
import type { RealtimeSession } from '../../../../application/models/connection/realtime-session.model.js';
import { RedisRelayInbox } from './redis-relay-inbox.adapter.js';
import { RedisSocketRegistry } from './redis-socket-registry.adapter.js';

/** Reads the Redis version used by the service in local development. */
function testRedisImage(): string {
  const compose = readFileSync(
    new URL('../../../../../../../compose.dev.yaml', import.meta.url),
    'utf8',
  );
  const image = /^\s*image:\s*(redis:\S+)\s*$/mu.exec(compose)?.[1];
  if (image === undefined) throw new Error('compose.dev.yaml names no Redis image.');
  return image;
}

/** Creates distinct identities, with a sufficient default lease for socket tests. */
function verifiedSession(): RealtimeSession {
  return {
    sessionId: randomUUID(),
    sessionVersion: 1,
    expiresAt: Date.now() + 30_000,
    organizationId: randomUUID(),
    memberId: randomUUID(),
    userId: randomUUID(),
    role: 'member',
  };
}

/** Reads a known registration's epoch, making a missing lease an immediate test failure. */
async function currentEpoch(
  registry: RedisSocketRegistry,
  socketId: string,
  session: RealtimeSession,
): Promise<string> {
  const epoch = await registry.readFence(socketId, session);
  if (epoch === null) throw new Error('The test registration is missing.');
  return epoch;
}

describe('Redis socket registry across two gateway instances', () => {
  const clients: ResilientRedisClient[] = [];
  let redis: StartedRedisContainer | undefined;
  let firstClient: ResilientRedisClient;
  let secondClient: ResilientRedisClient;
  let first: RedisSocketRegistry;
  let second: RedisSocketRegistry;

  beforeAll(async () => {
    redis = await new RedisContainer(testRedisImage()).start();
    const options = { enableOfflineQueue: false, lazyConnect: true, reportOutages: false };
    firstClient = new ResilientRedisClient(redis.getConnectionUrl(), options);
    secondClient = new ResilientRedisClient(redis.getConnectionUrl(), options);
    clients.push(firstClient, secondClient);
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    first = new RedisSocketRegistry(firstClient);
    second = new RedisSocketRegistry(secondClient);
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.shutDown()));
    await redis?.stop();
  });

  it('leases only the verified socket and rejects changes under a different organization', async () => {
    const session = verifiedSession();
    const otherTenant = { ...session, organizationId: randomUUID() };
    const socketId = randomUUID();
    expect(await first.register(socketId, session)).toBe(true);
    expect(await second.register(socketId, session)).toBe(false);
    expect(await second.register(socketId, otherTenant)).toBe(false);

    const epoch = await currentEpoch(second, socketId, session);
    expect(await second.readFence(socketId, otherTenant)).toBeNull();
    expect(
      await second.hasSubscription(socketId, session, epoch, `member:${session.memberId}`),
    ).toBe(true);
    expect(
      await second.hasSubscription(socketId, session, epoch, `org:${session.organizationId}`),
    ).toBe(true);
    expect(
      await second.join(
        socketId,
        session,
        epoch,
        { kind: 'organization' },
        `org:${otherTenant.organizationId}`,
      ),
    ).toBeNull();
    await second.unregister(socketId, otherTenant);
    expect(await first.readFence(socketId, session)).toBe(epoch);
    await second.unregister(socketId, session);
    await second.unregister(socketId, session);
    expect(await first.readFence(socketId, session)).toBeNull();
  });

  it('uses the Identity deadline for the socket and its subscriptions even after joining', async () => {
    const session = { ...verifiedSession(), expiresAt: Date.now() + 1_000 };
    const socketId = randomUUID();
    const room: RealtimeRoom = `task:${randomUUID()}`;
    expect(await first.register(socketId, session)).toBe(true);
    const fence = await currentEpoch(first, socketId, session);
    expect(
      await second.join(socketId, session, fence, { kind: 'task', taskKey: 'CAD-1' }, room),
    ).toEqual({ kind: 'joined', previousRoom: null });
    expect(await firstClient.pexpiretime(`realtime:connection:socket:${socketId}`)).toBe(
      session.expiresAt,
    );
    await vi.waitFor(
      async () => {
        expect(await second.readFence(socketId, session)).toBeNull();
      },
      { timeout: 3_000, interval: 50 },
    );
    expect(await first.register(randomUUID(), session)).toBe(false);
    expect(await second.hasSubscription(socketId, session, fence, room)).toBe(false);
  });

  it('fences old session versions and makes revocation terminal across late events', async () => {
    const session = verifiedSession();
    const oldSocket = randomUUID();
    const newSocket = randomUUID();
    const switched = { ...session, sessionVersion: 3, organizationId: randomUUID() };
    expect(await first.register(oldSocket, session)).toBe(true);
    await second.markOrganizationChanged(session.sessionId, 3);
    await first.markOrganizationChanged(session.sessionId, 2);
    expect(await second.readFence(oldSocket, session)).toBeNull();
    expect(await first.register(randomUUID(), session)).toBe(false);
    expect(await first.register(newSocket, switched)).toBe(true);

    await first.markSessionRevoked(session.sessionId, 4);
    await second.markOrganizationChanged(session.sessionId, 5);
    expect(await second.readFence(newSocket, switched)).toBeNull();
    expect(await second.register(randomUUID(), { ...switched, sessionVersion: 5 })).toBe(false);
  });

  it('leaves no usable registration after a concurrent handshake and revocation', async () => {
    const session = verifiedSession();
    const socketId = randomUUID();

    await Promise.all([
      first.register(socketId, session),
      second.markSessionRevoked(session.sessionId, 2),
    ]);

    expect(await first.readFence(socketId, session)).toBeNull();
    expect(await second.register(randomUUID(), session)).toBe(false);
  });

  it('does not let a role revert or an older membership event revive an old socket', async () => {
    const session = verifiedSession();
    const otherTenant = { ...verifiedSession(), memberId: session.memberId };
    const oldSocket = randomUUID();
    const otherSocket = randomUUID();
    expect(await first.register(oldSocket, session)).toBe(true);
    expect(await second.register(otherSocket, otherTenant)).toBe(true);

    await second.markMembershipRole(session.organizationId, session.memberId, 2, 'admin');
    expect(await first.register(randomUUID(), session)).toBe(false);
    await first.markMembershipRole(session.organizationId, session.memberId, 3, 'member');
    await second.markMembershipRole(session.organizationId, session.memberId, 2, 'admin');
    expect(await second.readFence(oldSocket, session)).toBeNull();
    const freshSocket = randomUUID();
    expect(await first.register(freshSocket, session)).toBe(true);

    await first.markMembershipRemoved(session.organizationId, session.memberId, 4);
    await second.markMembershipRole(session.organizationId, session.memberId, 5, 'member');
    expect(await second.readFence(freshSocket, session)).toBeNull();
    expect(await first.register(randomUUID(), session)).toBe(false);
    expect(await first.readFence(otherSocket, otherTenant)).toBe('0');
  });

  it('compares the tenant epoch after a visibility race and removes only the selected room', async () => {
    const session = verifiedSession();
    const socketId = randomUUID();
    const selection = { kind: 'task', taskKey: 'CAD-8' } as const;
    const previous: RealtimeRoom = `task:${randomUUID()}`;
    const next: RealtimeRoom = `task:${randomUUID()}`;
    expect(await first.register(socketId, session)).toBe(true);
    const initial = await currentEpoch(first, socketId, session);

    await second.advanceVisibility(randomUUID());
    expect(await second.readFence(socketId, session)).toBe(initial);
    await second.advanceVisibility(session.organizationId);
    expect(await first.join(socketId, session, initial, selection, previous)).toBeNull();
    const current = await currentEpoch(second, socketId, session);
    expect(current).not.toBe(initial);
    expect(await first.join(socketId, session, current, selection, previous)).toEqual({
      kind: 'joined',
      previousRoom: null,
    });
    expect(await second.hasSubscription(socketId, session, initial, previous)).toBe(false);
    expect(await second.hasSubscription(socketId, session, current, previous)).toBe(true);
    expect(await second.join(socketId, session, current, selection, next)).toEqual({
      kind: 'joined',
      previousRoom: previous,
    });
    expect(await first.hasSubscription(socketId, session, current, previous)).toBe(false);
    expect(await first.leave(socketId, session, selection)).toBe(next);
    expect(await first.leave(socketId, session, selection)).toBeNull();
    expect(await second.hasSubscription(socketId, session, current, next)).toBe(false);
    expect(
      await second.hasSubscription(socketId, session, current, `member:${session.memberId}`),
    ).toBe(true);
  });

  it('returns the original room result when Redis receives a command again after a lost reply', async () => {
    const session = verifiedSession();
    const socketId = randomUUID();
    const selection = { kind: 'task', taskKey: 'CAD-9' } as const;
    const previous: RealtimeRoom = `task:${randomUUID()}`;
    const next: RealtimeRoom = `task:${randomUUID()}`;
    const resend = new RedisSocketRegistry({
      eval: secondClient.eval.bind(secondClient),
      incr: secondClient.incr.bind(secondClient),
      sismember: secondClient.sismember.bind(secondClient),
      evalsha: async (digest, keys, ...parts) => {
        await secondClient.evalsha(digest, keys, ...parts);
        return secondClient.evalsha(digest, keys, ...parts);
      },
    });

    // Warm the script cache so the simulated retry also exercises the registration command.
    await first.readFence(socketId, session);
    expect(await resend.register(socketId, session)).toBe(true);
    const epoch = await currentEpoch(first, socketId, session);
    await first.join(socketId, session, epoch, selection, previous);
    expect(await resend.join(socketId, session, epoch, selection, next)).toEqual({
      kind: 'joined',
      previousRoom: previous,
    });
    expect(await resend.leave(socketId, session, selection)).toBe(next);
    expect(await first.hasSubscription(socketId, session, epoch, next)).toBe(false);
  });

  it('evicts a selected resource only under the current tenant fence and frees its room', async () => {
    const session = verifiedSession();
    const socketId = randomUUID();
    const selected = { kind: 'task', taskKey: 'CAD-2' } as const;
    const room = `task:${randomUUID()}` as const;
    expect(await first.register(socketId, session)).toBe(true);
    const previous = await currentEpoch(first, socketId, session);
    await first.join(socketId, session, previous, selected, room);
    await second.advanceVisibility(session.organizationId);
    const current = await currentEpoch(first, socketId, session);

    expect(await second.evict(socketId, session, previous, selected)).toBeNull();
    expect(
      await second.evict(socketId, { ...session, organizationId: randomUUID() }, current, selected),
    ).toBeNull();
    expect(await first.hasSubscription(socketId, session, current, room)).toBe(true);
    expect(await second.evict(socketId, session, current, selected)).toBe(room);
    expect(await second.evict(socketId, session, current, selected)).toBeNull();
    expect(await first.hasSubscription(socketId, session, current, room)).toBe(false);
    expect(
      await first.hasSubscription(socketId, session, current, `member:${session.memberId}`),
    ).toBe(true);
  });

  it('publishes only a current handoff to the replica that registered the socket', async () => {
    if (redis === undefined) throw new Error('Missing Redis fixture.');
    const listening = new ResilientRedisClient(redis.getConnectionUrl(), {
      enableOfflineQueue: false,
      lazyConnect: true,
      reportOutages: false,
    });
    clients.push(listening);
    await listening.connect();
    await listening.subscribe(first.deliveryChannel, second.deliveryChannel);
    const captured = vi.fn<(channel: string, packet: string) => void>();
    listening.on('message', captured);
    const session = verifiedSession();
    const socketId = randomUUID();
    const selection = { kind: 'task', taskKey: 'CAD-482' } as const;
    const room = `task:${randomUUID()}` as const;
    expect(await first.register(socketId, session)).toBe(true);
    const previous = await currentEpoch(first, socketId, session);
    await first.join(socketId, session, previous, selection, room);
    await second.advanceVisibility(session.organizationId);
    const current = await currentEpoch(first, socketId, session);
    const packet = { type: 'task.updated.v1', data: { changed: ['status'] } };

    expect(await second.publish(socketId, session, previous, room, packet)).toBe(false);
    const noticeId = randomUUID();
    expect(await second.noticeDelivered(session.organizationId, noticeId, socketId)).toBe(false);
    expect(await second.publish(socketId, session, current, room, packet, noticeId)).toBe(true);
    expect(await first.noticeDelivered(session.organizationId, noticeId, socketId)).toBe(true);
    expect(await second.noticeDelivered(randomUUID(), noticeId, socketId)).toBe(false);
    expect(await second.publish(socketId, session, current, room, packet, noticeId)).toBe(true);
    await vi.waitFor(() => {
      expect(captured).toHaveBeenCalledOnce();
    });
    const [channel, encoded] = captured.mock.calls[0] ?? [];
    expect(channel).toBe(first.deliveryChannel);
    if (encoded === undefined) throw new Error('Missing owner handoff.');
    const decoded: unknown = JSON.parse(encoded);
    expect(decoded).toMatchObject({ delivery: { socketId, fence: current, room, packet } });

    await first.markSessionRevoked(session.sessionId, 2);
    expect(await second.publish(socketId, session, current, room, packet)).toBe(false);
    expect(captured).toHaveBeenCalledOnce();
  });

  it('counts each dropped owner handoff at capacity and admits new handoffs when checks finish', async () => {
    if (redis === undefined) throw new Error('Missing Redis fixture.');
    const subscriberSource = new ResilientRedisClient(redis.getConnectionUrl(), {
      enableOfflineQueue: false,
      reportOutages: false,
    });
    clients.push(subscriberSource);
    const session = verifiedSession();
    const socketId = randomUUID();
    const room = `task:${randomUUID()}` as const;
    expect(await first.register(socketId, session)).toBe(true);
    const fence = await currentEpoch(first, socketId, session);
    await first.join(socketId, session, fence, { kind: 'task', taskKey: 'CAD-428' }, room);

    let releaseChecks = (): void => {
      throw new Error('The suspended checks did not initialize.');
    };
    const suspendedChecks = new Promise<void>((resolve) => {
      releaseChecks = () => {
        resolve();
      };
    });
    const receive = vi.fn<(payload: string) => Promise<void>>(() => suspendedChecks);
    const add = vi.fn<(value: number) => void>();
    const meter = metrics.getMeter('cadenway-realtime-gateway');
    const counter = vi.spyOn(meter, 'createCounter').mockReturnValue({ add });
    const getMeter = vi.spyOn(metrics, 'getMeter').mockReturnValue(meter);
    const unavailable = vi.fn();
    let inbox: RedisRelayInbox | undefined;
    try {
      inbox = new RedisRelayInbox(
        subscriberSource,
        first.deliveryChannel,
        receive,
        new RealtimeAdmissionGates(),
      );
      inbox.onUnavailable(unavailable);
      await vi.waitFor(() => {
        expect(inbox?.available).toBe(true);
      });
      const packet = { type: 'task.updated.v1', data: { changed: ['status'] } };
      const posted = await Promise.all(
        Array.from({ length: 130 }, () => second.publish(socketId, session, fence, room, packet)),
      );
      expect(posted.every(Boolean)).toBe(true);
      await vi.waitFor(() => {
        expect(receive).toHaveBeenCalledTimes(128);
        expect(add.mock.calls).toEqual([[1], [1]]);
      });
      expect(counter).toHaveBeenCalledExactlyOnceWith(
        'cadenway.realtime.relay.handoff.dropped',
        expect.objectContaining({ unit: '{handoff}' }),
      );
      expect(inbox.available).toBe(true);
      expect(unavailable).not.toHaveBeenCalled();

      const anotherTenant = { ...session, organizationId: randomUUID() };
      expect(await second.publish(socketId, anotherTenant, fence, room, packet)).toBe(false);
      releaseChecks();
      expect(await second.publish(socketId, session, fence, room, packet)).toBe(true);
      await vi.waitFor(() => {
        expect(receive).toHaveBeenCalledTimes(129);
      });
      expect(add.mock.calls).toEqual([[1], [1]]);
    } finally {
      releaseChecks();
      getMeter.mockRestore();
      counter.mockRestore();
      await inbox?.onApplicationShutdown();
      await first.unregister(socketId, session);
    }
  });

  it('keeps a tenant close marker after a missed broadcast and allows only new tenant sockets', async () => {
    const session = verifiedSession();
    const socketId = randomUUID();
    const other = verifiedSession();
    const otherSocket = randomUUID();
    expect(await first.register(socketId, session)).toBe(true);
    expect(await first.register(otherSocket, other)).toBe(true);

    const factId = randomUUID();
    await second.invalidateOrganizationLeases(session.organizationId, factId);
    expect(await first.readFence(socketId, session)).toBeNull();
    expect(await first.readFence(otherSocket, other)).toBe('0');
    const freshSocket = randomUUID();
    expect(await first.register(freshSocket, session)).toBe(true);
    await first.invalidateOrganizationLeases(session.organizationId, factId);
    expect(await second.readFence(freshSocket, session)).toBe('1');
  });

  it('closes only subscriptions bound to a changed space, with deduplicated redelivery', async () => {
    const session = verifiedSession();
    const affected = randomUUID();
    const unaffected = randomUUID();
    const spaceId = randomUUID();
    const otherSpaceId = randomUUID();
    const listId = randomUUID();
    const otherListId = randomUUID();
    const task = { kind: 'task', taskKey: 'CAD-42' } as const;
    const taskRoom = `task:${randomUUID()}` as const;
    const otherList = { kind: 'list', listId: otherListId } as const;
    const otherRoom = `list:${otherListId}` as const;
    expect(await first.register(affected, session)).toBe(true);
    expect(await first.register(unaffected, session)).toBe(true);
    const fence = await currentEpoch(first, affected, session);
    expect(
      await first.join(affected, session, fence, task, taskRoom, { listId, spaceId }),
    ).toMatchObject({ kind: 'joined' });
    expect(
      await first.join(unaffected, session, fence, otherList, otherRoom, {
        spaceId: otherSpaceId,
        listId: otherListId,
      }),
    ).toMatchObject({ kind: 'joined' });

    const factId = randomUUID();
    await second.invalidateScope(session.organizationId, 'space', spaceId, factId);
    expect(await first.readFence(affected, session)).toBeNull();
    const current = await currentEpoch(first, unaffected, session);
    expect(current).not.toBe(fence);
    expect(await first.hasSubscription(affected, session, current, taskRoom)).toBe(false);
    expect(await first.hasSubscription(unaffected, session, current, otherRoom)).toBe(true);

    const renewed = randomUUID();
    expect(await first.register(renewed, session)).toBe(true);
    expect(
      await first.join(renewed, session, current, task, taskRoom, { listId, spaceId }),
    ).toMatchObject({ kind: 'joined' });
    await second.invalidateScope(session.organizationId, 'space', spaceId, factId);
    expect(await first.readFence(renewed, session)).toBe(current);
    await second.invalidateScope(session.organizationId, 'list', listId, randomUUID());
    expect(await first.readFence(renewed, session)).toBeNull();
    expect(await first.readFence(unaffected, session)).not.toBeNull();
  });

  it('allocates one shared slot across concurrent joins and frees it only once on leave', async () => {
    const session = verifiedSession();
    const socketId = randomUUID();
    expect(await first.register(socketId, session)).toBe(true);
    const fence = await currentEpoch(first, socketId, session);
    const initialListId = randomUUID();
    const initialList = { kind: 'list', listId: initialListId } as const;
    const initialRoom = `list:${initialListId}` as const;
    const joined = { kind: 'joined', previousRoom: null };
    expect(await first.join(socketId, session, fence, initialList, initialRoom)).toEqual(joined);
    const fill = Array.from({ length: 30 }, (_, index) =>
      first.join(
        socketId,
        session,
        fence,
        { kind: 'task', taskKey: `CAD-${String(index + 1)}` },
        `task:${randomUUID()}`,
      ),
    );
    expect(await Promise.all(fill)).toEqual(Array.from({ length: 30 }, () => joined));

    const firstCandidate = { kind: 'task', taskKey: 'CAD-31' } as const;
    const firstRoom = `task:${randomUUID()}` as const;
    const secondListId = randomUUID();
    const secondCandidate = { kind: 'list', listId: secondListId } as const;
    const secondRoom = `list:${secondListId}` as const;
    const outcomes = await Promise.all([
      first.join(socketId, session, fence, firstCandidate, firstRoom),
      second.join(socketId, session, fence, secondCandidate, secondRoom),
    ]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes).toEqual(expect.arrayContaining([joined, { kind: 'room-limit' }]));

    expect(await first.join(socketId, session, fence, initialList, initialRoom)).toEqual({
      kind: 'joined',
      previousRoom: initialRoom,
    });
    const organization = { kind: 'organization' } as const;
    const organizationRoom = `org:${session.organizationId}` as const;
    expect(await first.leave(socketId, session, organization)).toBe(organizationRoom);
    expect(await second.join(socketId, session, fence, organization, organizationRoom)).toEqual(
      joined,
    );
    const retrySelection = outcomes[0]?.kind === 'joined' ? secondCandidate : firstCandidate;
    const retryRoom = outcomes[0]?.kind === 'joined' ? secondRoom : firstRoom;
    expect(await second.join(socketId, session, fence, retrySelection, retryRoom)).toEqual({
      kind: 'room-limit',
    });
    expect(await second.hasSubscription(socketId, session, fence, retryRoom)).toBe(false);
    expect(
      await second.hasSubscription(socketId, session, fence, `member:${session.memberId}`),
    ).toBe(true);

    expect(
      await Promise.all([
        first.leave(socketId, session, initialList),
        second.leave(socketId, session, initialList),
      ]),
    ).toEqual(expect.arrayContaining([initialRoom, null]));
    expect(await second.join(socketId, session, fence, retrySelection, retryRoom)).toEqual(joined);
    expect(await first.hasSubscription(socketId, session, fence, retryRoom)).toBe(true);
    const otherTask = { kind: 'task', taskKey: 'CAD-32' } as const;
    const otherRoom = `task:${randomUUID()}` as const;
    expect(await first.join(socketId, session, fence, otherTask, otherRoom)).toEqual({
      kind: 'room-limit',
    });

    await second.advanceVisibility(session.organizationId);
    expect(await first.join(socketId, session, fence, retrySelection, retryRoom)).toBeNull();
    const current = await currentEpoch(second, socketId, session);
    expect(await first.join(socketId, session, current, retrySelection, retryRoom)).toEqual({
      kind: 'joined',
      previousRoom: retryRoom,
    });
    const separateSocket = randomUUID();
    expect(await second.register(separateSocket, session)).toBe(true);
    expect(await second.join(separateSocket, session, current, otherTask, otherRoom)).toEqual(
      joined,
    );
  });
});
