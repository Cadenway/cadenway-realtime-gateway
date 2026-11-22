import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RealtimeSession } from '../../../../application/models/connection/realtime-session.model.js';
import type { TicketRedemptionPort } from '../../../../application/ports/outbound/identity/session/ticket-redemption.port.js';
import type { SocketRegistryPort } from '../../../../application/ports/outbound/redis/connection/socket-registry.port.js';
import type { RoomAccessPort } from '../../../../application/ports/outbound/task/visibility/room-access.port.js';
import { ChangeRoom } from '../../../../application/use-cases/commands/connection/change-room/change-room.use-case.js';
import { CheckConnection } from '../../../../application/use-cases/commands/connection/check-connection/check-connection.use-case.js';
import { TrackSocketPresence } from '../../../../application/use-cases/commands/connection/track-socket-presence/track-socket-presence.use-case.js';
import { RealtimeGateway } from './realtime.gateway.js';

const ticket = '0'.repeat(43);
const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const listId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30';
const taskId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31';
const spaceId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b35';

function sessionFixture(): RealtimeSession {
  return {
    organizationId,
    userId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b32',
    memberId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b33',
    sessionId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b34',
    sessionVersion: 3,
    role: 'member',
    expiresAt: Date.now() + 30_000,
  };
}

function adapterFixtures() {
  const session = sessionFixture();
  const identity = {
    redeem: vi.fn<TicketRedemptionPort['redeem']>().mockResolvedValue(session),
  } satisfies TicketRedemptionPort;
  const access = {
    list: vi.fn<RoomAccessPort['list']>().mockResolvedValue({ organizationId, listId, spaceId }),
    task: vi
      .fn<RoomAccessPort['task']>()
      .mockResolvedValue({ organizationId, listId, spaceId, taskId, taskKey: 'CAD-482' }),
  } satisfies RoomAccessPort;
  const registry = {
    register: vi.fn<SocketRegistryPort['register']>().mockResolvedValue(true),
    readFence: vi.fn<SocketRegistryPort['readFence']>().mockResolvedValue('7'),
    join: vi
      .fn<SocketRegistryPort['join']>()
      .mockResolvedValue({ kind: 'joined', previousRoom: null }),
    leave: vi.fn<SocketRegistryPort['leave']>().mockResolvedValue(null),
    unregister: vi.fn<SocketRegistryPort['unregister']>().mockResolvedValue(undefined),
  } satisfies SocketRegistryPort;
  const presence = {
    execute: vi.fn<TrackSocketPresence['execute']>().mockResolvedValue(true),
    heartbeat: vi.fn<TrackSocketPresence['heartbeat']>().mockResolvedValue(true),
    set: vi.fn<TrackSocketPresence['set']>().mockResolvedValue(true),
    disconnect: vi.fn<TrackSocketPresence['disconnect']>().mockResolvedValue(undefined),
  };
  return { session, identity, access, registry, presence };
}

describe('RealtimeGateway', () => {
  let app: INestApplication | undefined;
  let socket: Socket | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    socket?.disconnect();
    socket = undefined;
    await app?.close();
    app = undefined;
  });

  async function connectClient(
    adapters?: ReturnType<typeof adapterFixtures>,
    auth: Readonly<Record<string, unknown>> = { token: ticket },
  ): Promise<Socket> {
    const builder = Test.createTestingModule({
      providers: [
        RealtimeGateway,
        {
          provide: CheckConnection,
          useValue: new CheckConnection(adapters?.identity, adapters?.registry, {
            matches: () => Promise.resolve(true),
          }),
        },
        { provide: ChangeRoom, useValue: new ChangeRoom(adapters?.access, adapters?.registry) },
        { provide: TrackSocketPresence, useValue: adapters?.presence ?? {} },
      ],
    });
    const moduleRef: TestingModule = await builder.compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    socket = io(await app.getUrl(), {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      auth,
    });
    return socket;
  }

  function hello(client: Socket): Promise<unknown> {
    return new Promise((resolve, reject) => {
      client.once('hello', resolve);
      client.once('connect_error', reject);
    });
  }

  function closed(client: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      client.once('disconnect', resolve);
      client.once('connect_error', reject);
    });
  }

  it('closes a socket while authoritative adapters are unavailable', async () => {
    const client = await connectClient();
    const refusal = closed(client);
    client.connect();
    await expect(refusal).resolves.toBe('io server disconnect');
  });

  it('closes malformed auth before reaching Identity', async () => {
    const adapters = adapterFixtures();
    const client = await connectClient(adapters, { token: 'short', organizationId });
    const refusal = closed(client);
    client.connect();
    await expect(refusal).resolves.toBe('io server disconnect');
    expect(adapters.identity.redeem).not.toHaveBeenCalled();
  });

  it('redeems a ticket once and sends a safe hello after checking the registration', async () => {
    const adapters = adapterFixtures();
    const client = await connectClient(adapters);
    const ready = hello(client);
    client.connect();
    const message = await ready;
    expect(message).toMatchObject({
      type: 'connection.ready.v1',
      version: 1,
      data: {
        organizationId,
        sessionExpiresAt: new Date(adapters.session.expiresAt).toISOString(),
        heartbeatIntervalSeconds: 30,
      },
    });
    expect(message).toHaveProperty('id', expect.any(String));
    expect(message).toHaveProperty('at', expect.any(String));
    expect(message).not.toHaveProperty('data.memberId');
    expect(message).not.toHaveProperty('data.sessionId');
    expect(adapters.identity.redeem).toHaveBeenCalledExactlyOnceWith(ticket);
    expect(adapters.registry.register).toHaveBeenCalledExactlyOnceWith(client.id, adapters.session);
    expect(adapters.registry.readFence).toHaveBeenCalledTimes(2);
    expect(adapters.registry.readFence).toHaveBeenLastCalledWith(client.id, adapters.session);
    const socketId = client.id;
    client.disconnect();
    await vi.waitFor(() => {
      expect(adapters.registry.unregister).toHaveBeenCalledExactlyOnceWith(
        socketId,
        adapters.session,
      );
    });
  });

  it('does not retry an ambiguous redemption or register a socket', async () => {
    const adapters = adapterFixtures();
    adapters.identity.redeem.mockRejectedValueOnce(new Error('Identity unavailable'));
    const client = await connectClient(adapters);
    const refusal = closed(client);
    client.connect();
    await expect(refusal).resolves.toBe('io server disconnect');
    expect(adapters.identity.redeem).toHaveBeenCalledExactlyOnceWith(ticket);
    expect(adapters.registry.register).not.toHaveBeenCalled();
  });

  it('requires a fresh ticket when the same client reconnects', async () => {
    const adapters = adapterFixtures();
    adapters.identity.redeem.mockResolvedValueOnce(adapters.session).mockResolvedValueOnce(null);
    const client = await connectClient(adapters);
    const ready = hello(client);
    client.connect();
    await ready;

    client.disconnect();
    const refused = closed(client);
    client.connect();
    await expect(refused).resolves.toBe('io server disconnect');
    expect(adapters.identity.redeem).toHaveBeenCalledTimes(2);
    expect(adapters.registry.register).toHaveBeenCalledOnce();
  });

  it('refuses a redeemed session that already expired', async () => {
    const adapters = adapterFixtures();
    adapters.identity.redeem.mockResolvedValueOnce({
      ...adapters.session,
      expiresAt: Date.now() - 1,
    });
    const client = await connectClient(adapters);
    const refusal = closed(client);
    client.connect();
    await expect(refusal).resolves.toBe('io server disconnect');
    expect(adapters.registry.register).not.toHaveBeenCalled();
  });

  it('closes a socket invalidated during registration without sending hello', async () => {
    const adapters = adapterFixtures();
    adapters.registry.readFence.mockResolvedValueOnce(null);
    const client = await connectClient(adapters);
    const onHello = vi.fn();
    client.on('hello', onHello);
    const refusal = closed(client);
    client.connect();
    await expect(refusal).resolves.toBe('io server disconnect');
    expect(onHello).not.toHaveBeenCalled();
    expect(adapters.registry.unregister).toHaveBeenCalledOnce();
  });

  it('joins only the task UUID proved by Task and leaves by the stored selector', async () => {
    const adapters = adapterFixtures();
    adapters.registry.leave.mockResolvedValueOnce(`task:${taskId}`);
    const client = await connectClient(adapters);
    const ready = hello(client);
    client.connect();
    await ready;

    const task = { kind: 'task', taskKey: 'CAD-482' };
    await expect(client.emitWithAck('room:join', task)).resolves.toEqual({ ok: true });
    expect(adapters.access.task).toHaveBeenCalledExactlyOnceWith(adapters.session, 'CAD-482');
    expect(adapters.registry.join).toHaveBeenCalledExactlyOnceWith(
      client.id,
      adapters.session,
      '7',
      task,
      `task:${taskId}`,
      { organizationId, listId, spaceId, taskId, taskKey: task.taskKey },
    );
    await expect(client.emitWithAck('room:leave', task)).resolves.toEqual({ ok: true });
    await expect(client.emitWithAck('room:leave', task)).resolves.toEqual({ ok: true });
    expect(adapters.registry.leave).toHaveBeenNthCalledWith(2, client.id, adapters.session, task);
    expect(adapters.access.task).toHaveBeenCalledOnce();
  });

  it('reports room capacity without disconnecting or blocking later room changes', async () => {
    const adapters = adapterFixtures();
    adapters.registry.join.mockResolvedValueOnce({ kind: 'room-limit' });
    const client = await connectClient(adapters);
    const ready = hello(client);
    client.connect();
    await ready;

    const task = { kind: 'task', taskKey: 'CAD-482' };
    await expect(client.emitWithAck('room:join', task)).resolves.toEqual({
      ok: false,
      code: 'room.limit-reached',
    });
    expect(client.connected).toBe(true);
    expect(adapters.access.task).toHaveBeenCalledExactlyOnceWith(adapters.session, 'CAD-482');
    await expect(client.emitWithAck('room:leave', { kind: 'list', listId })).resolves.toEqual({
      ok: true,
    });
    await expect(client.emitWithAck('room:join', task)).resolves.toEqual({ ok: true });
  });

  it('refuses a room selected by client tenant or UUID and conceals a cross-tenant proof', async () => {
    const adapters = adapterFixtures();
    adapters.access.list.mockResolvedValueOnce({ organizationId: taskId, listId, spaceId });
    adapters.access.task.mockResolvedValueOnce({
      organizationId,
      listId,
      spaceId,
      taskKey: 'CAD-482',
    });
    const client = await connectClient(adapters);
    const ready = hello(client);
    client.connect();
    await ready;

    await expect(
      client.emitWithAck('room:join', { kind: 'organization', organizationId: taskId }),
    ).resolves.toEqual({ ok: false, code: 'request.invalid' });
    await expect(
      client.emitWithAck('room:join', { kind: 'task', taskKey: 'CAD-482', taskId }),
    ).resolves.toEqual({ ok: false, code: 'request.invalid' });
    await expect(client.emitWithAck('room:join', { kind: 'list', listId })).resolves.toEqual({
      ok: false,
      code: 'room.not-found',
    });
    await expect(
      client.emitWithAck('room:join', { kind: 'task', taskKey: 'CAD-482' }),
    ).resolves.toEqual({ ok: false, code: 'room.not-found' });
    expect(adapters.access.task).toHaveBeenCalledExactlyOnceWith(adapters.session, 'CAD-482');
    expect(adapters.access.list).toHaveBeenCalledExactlyOnceWith(adapters.session, listId);
    expect(adapters.registry.join).not.toHaveBeenCalled();
  });

  it('keeps an authorized socket open when a different visibility change interrupts a join', async () => {
    const adapters = adapterFixtures();
    adapters.registry.join.mockResolvedValueOnce(null);
    const client = await connectClient(adapters);
    const ready = hello(client);
    client.connect();
    await ready;

    await expect(client.emitWithAck('room:join', { kind: 'list', listId })).resolves.toEqual({
      ok: false,
      code: 'realtime.unavailable',
    });
    expect(adapters.registry.join).toHaveBeenCalledOnce();
    expect(client.connected).toBe(true);
  });

  it('keeps the socket available after a failed Task check that did not join a room', async () => {
    const adapters = adapterFixtures();
    adapters.access.list.mockRejectedValueOnce(new Error('Task unavailable'));
    const client = await connectClient(adapters);
    const ready = hello(client);
    client.connect();
    await ready;

    const selection = { kind: 'list', listId };
    await expect(client.emitWithAck('room:join', selection)).resolves.toEqual({
      ok: false,
      code: 'realtime.unavailable',
    });
    expect(adapters.registry.join).not.toHaveBeenCalled();
    await expect(client.emitWithAck('room:join', selection)).resolves.toEqual({ ok: true });
  });

  it('closes an invalidated socket before acknowledging the applied room', async () => {
    const adapters = adapterFixtures();
    adapters.registry.readFence
      .mockResolvedValueOnce('7')
      .mockResolvedValueOnce('7')
      .mockResolvedValueOnce('7')
      .mockResolvedValueOnce(null);
    const client = await connectClient(adapters);
    const ready = hello(client);
    client.connect();
    await ready;

    const acknowledged = vi.fn();
    const invalidated = closed(client);
    client.emit('room:join', { kind: 'list', listId: listId.toUpperCase() }, acknowledged);
    await expect(invalidated).resolves.toBe('io server disconnect');
    expect(adapters.access.list).toHaveBeenCalledExactlyOnceWith(adapters.session, listId);
    expect(adapters.registry.join).toHaveBeenCalledOnce();
    expect(acknowledged).not.toHaveBeenCalled();
  });

  it('closes at the Identity lease deadline and releases the registration', async () => {
    const adapters = adapterFixtures();
    adapters.identity.redeem.mockImplementationOnce(() =>
      Promise.resolve({ ...adapters.session, expiresAt: Date.now() + 500 }),
    );
    const client = await connectClient(adapters);
    const ready = hello(client);
    const expired = closed(client);
    client.connect();
    await ready;

    await expect(expired).resolves.toBe('io server disconnect');
    await vi.waitFor(() => {
      expect(adapters.registry.unregister).toHaveBeenCalledOnce();
    });
  });

  it('closes an idle socket when its shared fence changes without a close broadcast', async () => {
    const adapters = adapterFixtures();
    const client = await connectClient(adapters);
    const ready = hello(client);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    client.connect();
    await ready;

    const closedByWatchdog = closed(client);
    adapters.registry.readFence.mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(closedByWatchdog).resolves.toBe('io server disconnect');
    expect(adapters.registry.unregister).toHaveBeenCalledOnce();
  });

  it('refreshes and sets presence only for the verified live membership', async () => {
    const adapters = adapterFixtures();
    const client = await connectClient(adapters);
    const ready = hello(client);
    client.connect();
    await ready;

    const socketId = client.id;
    expect(adapters.presence.execute).toHaveBeenCalledExactlyOnceWith(socketId, adapters.session);
    await expect(client.emitWithAck('presence:heartbeat', { memberId: taskId })).resolves.toEqual({
      ok: false,
      code: 'request.invalid',
    });
    await expect(client.emitWithAck('presence:set', { status: 'offline' })).resolves.toEqual({
      ok: false,
      code: 'request.invalid',
    });
    await expect(client.emitWithAck('presence:heartbeat', {})).resolves.toEqual({ ok: true });
    await expect(client.emitWithAck('presence:set', { status: 'invisible' })).resolves.toEqual({
      ok: true,
    });
    expect(adapters.presence.heartbeat).toHaveBeenCalledExactlyOnceWith(socketId, adapters.session);
    expect(adapters.presence.set).toHaveBeenCalledExactlyOnceWith(
      socketId,
      adapters.session,
      'invisible',
    );

    adapters.registry.readFence.mockResolvedValueOnce(null);
    const invalidated = closed(client);
    client.emit('presence:heartbeat', {});
    await expect(invalidated).resolves.toBe('io server disconnect');
    expect(adapters.presence.heartbeat).toHaveBeenCalledOnce();
    expect(adapters.presence.disconnect).toHaveBeenCalledExactlyOnceWith(
      socketId,
      adapters.session,
    );
  });
});
