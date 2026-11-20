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
) {
  const remoteDirectory = vi.fn();
  const server = {
    in: remoteDirectory,
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
    receiver: new SocketIoRecipients(() => server, registry, available),
    registry,
    available,
    remoteDirectory,
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
    await receiver.deliverPresence(organizationId, packet);

    expect(remoteDirectory).not.toHaveBeenCalled();
    expect(registry.readFence).toHaveBeenCalledExactlyOnceWith(
      target.id,
      target.data.realtimeSession,
    );
    expect(target.volatile.emit).toHaveBeenCalledExactlyOnceWith('change', packet);
    expect(staleForeign.volatile.emit).not.toHaveBeenCalled();
  });
});
