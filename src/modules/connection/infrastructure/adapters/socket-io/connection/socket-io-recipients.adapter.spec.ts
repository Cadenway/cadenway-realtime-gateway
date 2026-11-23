import type { Server } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';

import type { RealtimeSession } from '../../../../application/models/connection/realtime-session.model.js';
import type { RedisSocketRegistry } from '../../redis/connection/redis-socket-registry.adapter.js';
import { SocketIoRecipients } from './socket-io-recipients.adapter.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const taskRoom = 'task:019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30';

function session(): RealtimeSession {
  return {
    organizationId,
    sessionId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31',
    userId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b32',
    memberId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b33',
    sessionVersion: 2,
    expiresAt: Date.now() + 30_000,
    role: 'member',
  };
}

function socket(id: string, rooms: readonly string[] = [taskRoom]) {
  return {
    id,
    connected: true,
    rooms: new Set(rooms),
    data: { realtimeReady: true, realtimeSession: session() },
    volatile: { emit: vi.fn() },
  };
}

function replica(
  local: readonly ReturnType<typeof socket>[],
  roomIndex = new Map<string, Set<string>>(),
  pagedDiscovery = true,
) {
  const remoteDirectory = vi.fn();
  const register = vi.fn();
  const requestPages = vi
    .fn<(event: string, room: string, cursor: string) => Promise<unknown>>()
    .mockResolvedValue([]);
  const server = {
    in: remoteDirectory,
    on: register,
    serverSideEmitWithAck: requestPages,
    sockets: {
      sockets: new Map(local.map((value) => [value.id, value])),
      adapter: { rooms: roomIndex },
    },
  } as unknown as Server;
  const registry = {
    readFence: vi.fn<RedisSocketRegistry['readFence']>().mockResolvedValue('4'),
    hasSubscription: vi.fn<RedisSocketRegistry['hasSubscription']>().mockResolvedValue(true),
  };
  const available = vi.fn(() => true);
  return {
    receiver: new SocketIoRecipients(() => server, registry, available, pagedDiscovery),
    registry,
    available,
    remoteDirectory,
    requestPages,
    register,
  };
}

function handoff(socketId: string, deadline = Date.now() + 5_000): string {
  return JSON.stringify({
    deadline,
    delivery: {
      socketId,
      room: taskRoom,
      fence: '4',
      packet: { type: 'task.updated.v1' },
    },
  });
}

describe('owning socket replica', () => {
  it('keeps legacy discovery while installing page support during the compatibility rollout', async () => {
    const room = `task-key:${organizationId}:CAD-42`;
    const selected = socket('legacy');
    const { receiver, remoteDirectory, requestPages, register } = replica([], new Map(), false);
    remoteDirectory.mockReturnValue({ fetchSockets: vi.fn().mockResolvedValue([selected]) });

    receiver.onModuleInit();
    const pages = [];
    for await (const page of receiver.scan(room, new AbortController().signal)) pages.push(page);

    expect(pages).toEqual([[{ socketId: selected.id, session: selected.data.realtimeSession }]]);
    expect(remoteDirectory).toHaveBeenCalledExactlyOnceWith(room);
    expect(requestPages).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledExactlyOnceWith(
      'cadenway:recipient-page:v1',
      expect.any(Function),
    );
  });

  it('streams a large room without skipping remote sockets beyond the safe cursor', async () => {
    const room = `task-key:${organizationId}:CAD-42`;
    const local = Array.from({ length: 34 }, (_, index) =>
      socket(`a${String(index).padStart(2, '0')}`),
    );
    const remote = { socketId: 'b00', session: session() };
    const { receiver, remoteDirectory, requestPages } = replica(
      local,
      new Map([[room, new Set(local.map(({ id }) => id))]]),
    );
    requestPages.mockResolvedValue([{ recipients: [remote], hasMore: false }]);
    const pages: string[][] = [];

    for await (const page of receiver.scan(room, new AbortController().signal)) {
      pages.push(page.map(({ socketId }) => socketId));
    }

    expect(pages).toEqual([local.slice(0, 32).map(({ id }) => id), ['b00', 'a32', 'a33']]);
    expect(requestPages.mock.calls.map(([, , cursor]) => cursor)).toEqual(['', 'a31']);
    expect(remoteDirectory).not.toHaveBeenCalled();
  });

  it('rejects an incomplete replica response and lets the broker retry', async () => {
    const { receiver, requestPages } = replica([]);
    requestPages.mockResolvedValue([{ recipients: [], hasMore: true }]);
    await expect(
      receiver
        .scan(`task-key:${organizationId}:CAD-42`, new AbortController().signal)
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toThrow('Incomplete realtime recipient page.');
  });

  it('abandons recipient discovery when the broker deadline expires before a replica replies', async () => {
    const { receiver, requestPages } = replica([]);
    requestPages.mockImplementation(() => new Promise(() => undefined));
    const delivery = new AbortController();
    const result = receiver
      .scan(`task-key:${organizationId}:CAD-42`, delivery.signal)
      [Symbol.asyncIterator]()
      .next();

    delivery.abort();

    await expect(result).rejects.toThrow('Realtime recipient discovery expired.');
  });

  it('sends a valid handoff only to the local socket on the owning replica', async () => {
    const target = socket('first-socket');
    const other = socket('second-socket');
    const first = replica([target]);
    const second = replica([other]);

    await Promise.all([
      first.receiver.receive(handoff(target.id)),
      second.receiver.receive(handoff(target.id)),
    ]);

    expect(first.registry.hasSubscription).toHaveBeenCalledExactlyOnceWith(
      target.id,
      target.data.realtimeSession,
      '4',
      taskRoom,
    );
    expect(second.registry.hasSubscription).not.toHaveBeenCalled();
    expect(target.volatile.emit).toHaveBeenCalledExactlyOnceWith('change', {
      type: 'task.updated.v1',
    });
    expect(other.volatile.emit).not.toHaveBeenCalled();
  });

  it('drops a handoff revoked after publication and before the owning replica can emit', async () => {
    const target = socket('socket');
    const { receiver, registry } = replica([target]);
    registry.hasSubscription.mockResolvedValueOnce(false);

    await receiver.receive(handoff(target.id));

    expect(registry.hasSubscription).toHaveBeenCalledOnce();
    expect(target.volatile.emit).not.toHaveBeenCalled();
  });

  it('drops an expired handoff and one that completes after local availability is lost', async () => {
    const target = socket('socket');
    const { receiver, available, registry } = replica([target]);

    await receiver.receive(handoff(target.id, Date.now()));
    expect(registry.hasSubscription).not.toHaveBeenCalled();

    registry.hasSubscription.mockImplementationOnce(() => {
      available.mockReturnValue(false);
      return Promise.resolve(true);
    });
    await receiver.receive(handoff(target.id));
    expect(target.volatile.emit).not.toHaveBeenCalled();
  });

  it('uses only the local organization index and rechecks scope before presence delivery', async () => {
    const room = `org:${organizationId}`;
    const target = socket('owned', [room]);
    const staleForeign = socket('foreign', [room]);
    staleForeign.data.realtimeSession = {
      ...staleForeign.data.realtimeSession,
      organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b34',
    };
    const { receiver, remoteDirectory, registry } = replica(
      [target, staleForeign],
      new Map([[room, new Set([target.id, staleForeign.id, 'not-local'])]]),
    );
    const packet = { type: 'user.status-changed.v1' };
    await receiver.deliverPresence(organizationId, packet, () => true);

    expect(remoteDirectory).not.toHaveBeenCalled();
    expect(registry.readFence).toHaveBeenCalledExactlyOnceWith(
      target.id,
      target.data.realtimeSession,
    );
    expect(target.volatile.emit).toHaveBeenCalledExactlyOnceWith('change', packet);
    expect(staleForeign.volatile.emit).not.toHaveBeenCalled();
  });

  it('does not emit an old online status after a newer invisible member becomes offline', async () => {
    const room = `org:${organizationId}`;
    const target = socket('owned', [room]);
    const { receiver, registry } = replica([target], new Map([[room, new Set([target.id])]]));
    let completeAuthorization!: (allowed: boolean) => void;
    const delayedAuthorization = new Promise<boolean>((resolve) => {
      completeAuthorization = resolve;
    });
    registry.hasSubscription.mockReturnValueOnce(delayedAuthorization);
    let current = true;
    const online = { type: 'user.status-changed.v1', data: { status: 'online' } };
    const invisible = { type: 'user.status-changed.v1', data: { status: 'offline' } };

    const oldDelivery = receiver.deliverPresence(organizationId, online, () => current);
    await vi.waitFor(() => {
      expect(registry.hasSubscription).toHaveBeenCalledOnce();
    });
    current = false;
    await receiver.deliverPresence(organizationId, invisible, () => true);
    completeAuthorization(true);
    await oldDelivery;

    expect(target.volatile.emit).toHaveBeenCalledExactlyOnceWith('change', invisible);
  });
});
