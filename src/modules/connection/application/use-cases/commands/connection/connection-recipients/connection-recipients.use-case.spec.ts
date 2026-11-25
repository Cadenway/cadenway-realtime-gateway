import { describe, expect, it, vi } from 'vitest';

import type { ConnectionRecipient } from '../../../../models/connection/connection-recipient.model.js';
import type { RecipientRegistry } from '../../../../ports/outbound/redis/connection/recipient-registry.port.js';
import type { RecipientTransport } from '../../../../ports/outbound/socket-io/connection/recipient-transport.port.js';
import type { RoomAccessPort } from '../../../../ports/outbound/task/visibility/room-access.port.js';
import { ConnectionRecipients } from './connection-recipients.use-case.js';

const organization = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const otherOrganization = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30';
const listId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31';
const spaceId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b32';
const taskId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b33';
const taskKey = 'CAD-482';

function recipient(): ConnectionRecipient {
  return {
    socketId: 'socket',
    session: {
      organizationId: organization,
      userId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b34',
      memberId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b35',
      sessionId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b36',
      sessionVersion: 2,
      expiresAt: Date.now() + 30_000,
      role: 'member',
    },
  };
}

function fixture() {
  const registry = {
    readFence: vi.fn<RecipientRegistry['readFence']>().mockResolvedValue('5'),
    noticeDelivered: vi.fn<RecipientRegistry['noticeDelivered']>().mockResolvedValue(false),
    publish: vi.fn<RecipientRegistry['publish']>().mockResolvedValue(true),
    evict: vi.fn<RecipientRegistry['evict']>().mockResolvedValue(null),
    markOrganizationChanged: vi
      .fn<RecipientRegistry['markOrganizationChanged']>()
      .mockResolvedValue(undefined),
    markSessionRevoked: vi
      .fn<RecipientRegistry['markSessionRevoked']>()
      .mockResolvedValue(undefined),
    markMembershipRole: vi
      .fn<RecipientRegistry['markMembershipRole']>()
      .mockResolvedValue(undefined),
    markMembershipRemoved: vi
      .fn<RecipientRegistry['markMembershipRemoved']>()
      .mockResolvedValue(undefined),
    advanceVisibility: vi.fn<RecipientRegistry['advanceVisibility']>().mockResolvedValue(undefined),
    invalidateScope: vi.fn<RecipientRegistry['invalidateScope']>().mockResolvedValue(undefined),
    invalidateOrganizationLeases: vi
      .fn<RecipientRegistry['invalidateOrganizationLeases']>()
      .mockResolvedValue(undefined),
  } satisfies RecipientRegistry;
  const transport = {
    scan: vi.fn<RecipientTransport['scan']>(),
    read: vi.fn<RecipientTransport['read']>().mockResolvedValue([]),
    leave: vi.fn<RecipientTransport['leave']>(),
    disconnect: vi.fn<RecipientTransport['disconnect']>(),
  } satisfies RecipientTransport;
  const access = {
    list: vi.fn<RoomAccessPort['list']>().mockResolvedValue(null),
    task: vi.fn<RoomAccessPort['task']>().mockResolvedValue(null),
    subject: vi.fn<RoomAccessPort['subject']>().mockResolvedValue(false),
  } satisfies RoomAccessPort;
  return {
    registry,
    transport,
    access,
    connections: new ConnectionRecipients(registry, transport, access),
  };
}

describe('ConnectionRecipients', () => {
  it('finds only the named account in the organization account index', async () => {
    const { connections, transport } = fixture();
    const selected = recipient();
    transport.read.mockResolvedValue([
      selected,
      {
        ...selected,
        socketId: 'other-org',
        session: { ...selected.session, organizationId: otherOrganization },
      },
      { ...selected, socketId: 'other-account', session: { ...selected.session, userId: 'other' } },
    ]);

    await expect(connections.readAccount(organization, selected.session.userId)).resolves.toEqual([
      selected,
    ]);
    expect(transport.read).toHaveBeenCalledExactlyOnceWith(
      `account:${organization}:${selected.session.userId}`,
    );
  });

  it('checks subject visibility using the recipient session', async () => {
    const { connections, access } = fixture();
    const selected = recipient();
    const subject = { kind: 'task-id', taskId } as const;
    const signal = new AbortController().signal;
    access.subject.mockResolvedValue(true);

    await expect(connections.subjectVisible(selected, subject, signal)).resolves.toBe(true);
    expect(access.subject).toHaveBeenCalledExactlyOnceWith(selected.session, subject, signal);
  });

  it('finds only tenant recipients of the private Task key index', async () => {
    const { connections, transport } = fixture();
    const selected = recipient();
    transport.read.mockResolvedValue([
      selected,
      {
        ...selected,
        socketId: 'other',
        session: { ...selected.session, organizationId: otherOrganization },
      },
    ]);

    await expect(connections.readTask(organization, taskKey)).resolves.toEqual([selected]);
    expect(transport.read).toHaveBeenCalledExactlyOnceWith(`task-key:${organization}:${taskKey}`);
  });

  it('refuses a Task placement from another tenant or without a stable UUID', async () => {
    const { connections, access } = fixture();
    const selected = recipient();
    const selection = { kind: 'task', taskKey } as const;
    access.task
      .mockResolvedValueOnce({
        organizationId: otherOrganization,
        spaceId,
        listId,
        taskKey,
        taskId,
      })
      .mockResolvedValueOnce({ organizationId: organization, spaceId, listId, taskKey })
      .mockResolvedValueOnce({ organizationId: organization, spaceId, listId, taskKey, taskId });

    await expect(connections.authorized(selected, selection)).resolves.toBeNull();
    await expect(connections.authorized(selected, selection)).resolves.toBeNull();
    await expect(connections.authorized(selected, selection)).resolves.toMatchObject({
      spaceId,
      listId,
      taskId,
      taskKey,
    });
    expect(access.task).toHaveBeenLastCalledWith(selected.session, taskKey, undefined);
  });

  it('keeps the fence and publication in a single registry operation', async () => {
    const { connections, registry } = fixture();
    const selected = recipient();
    const room = `task:${taskId}` as const;
    const packet = { type: 'task.updated.v1' };
    registry.publish.mockResolvedValueOnce(false);

    await expect(connections.deliver(selected, room, '4', packet)).resolves.toBe(false);
    await expect(connections.deliver(selected, room, '5', packet)).resolves.toBe(true);
    expect(registry.publish).toHaveBeenLastCalledWith(
      selected.socketId,
      selected.session,
      '5',
      room,
      packet,
      undefined,
    );
    await connections.deliver(selected, room, '5', packet, 'notice');
    expect(registry.publish).toHaveBeenLastCalledWith(
      selected.socketId,
      selected.session,
      '5',
      room,
      packet,
      'notice',
    );
    await connections.noticeDelivered(selected, 'notice');
    expect(registry.noticeDelivered).toHaveBeenCalledWith(
      selected.session.organizationId,
      'notice',
      selected.socketId,
    );
  });

  it('closes an earlier session context after fencing and preserves a current socket', async () => {
    const { connections, registry, transport } = fixture();
    const earlier = recipient();
    const current = {
      ...earlier,
      socketId: 'current',
      session: { ...earlier.session, sessionVersion: 3 },
    };
    transport.read.mockResolvedValue([earlier, current]);
    registry.readFence.mockResolvedValueOnce(null);

    await connections.switchSession(earlier.session.sessionId, 3);

    expect(registry.markOrganizationChanged).toHaveBeenCalledExactlyOnceWith(
      earlier.session.sessionId,
      3,
    );
    expect(transport.read).toHaveBeenCalledExactlyOnceWith(
      `session:${earlier.session.sessionId}`,
      true,
    );
    expect(transport.disconnect).toHaveBeenCalledExactlyOnceWith(earlier);
    expect(registry.markOrganizationChanged.mock.invocationCallOrder[0]).toBeLessThan(
      registry.readFence.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('passes the producer fact to the durable organization marker', async () => {
    const { connections, registry, transport } = fixture();
    const eventId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b37';
    await connections.disconnectOrganization(organization, eventId);
    expect(registry.invalidateOrganizationLeases).toHaveBeenCalledExactlyOnceWith(
      organization,
      eventId,
    );
    expect(transport.disconnect).not.toHaveBeenCalled();
  });

  it('removes both indexes for a revoked Task selection without resolving it', async () => {
    const { connections, registry, transport, access } = fixture();
    const selected = recipient();
    const canonical = `task:${taskId}` as const;
    registry.evict.mockResolvedValue(canonical);

    await connections.evict(selected, { kind: 'task', taskKey }, '5');

    expect(registry.evict).toHaveBeenCalledExactlyOnceWith(
      selected.socketId,
      selected.session,
      '5',
      { kind: 'task', taskKey },
    );
    expect(transport.leave).toHaveBeenCalledExactlyOnceWith(selected, [
      canonical,
      `task-key:${organization}:${taskKey}`,
    ]);
    expect(access.task).not.toHaveBeenCalled();
  });

  it('fences trash before discovery and keeps restored rooms with current Task access', async () => {
    const { connections, registry, transport, access } = fixture();
    const hidden = recipient();
    const restored = {
      ...hidden,
      socketId: 'restored',
      session: { ...hidden.session, userId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b37' },
    };
    const outside = {
      ...hidden,
      socketId: 'outside',
      session: { ...hidden.session, organizationId: otherOrganization },
    };
    transport.read.mockResolvedValue([hidden, restored, outside]);
    access.task.mockImplementation((session) =>
      Promise.resolve(
        session.userId === restored.session.userId
          ? { organizationId: organization, spaceId, listId, taskKey, taskId }
          : null,
      ),
    );
    const room = `task:${taskId}` as const;
    registry.evict.mockResolvedValue(room);
    const signal = new AbortController().signal;

    await connections.invalidateTaskRoom(organization, taskKey, 'trash', signal);

    expect(registry.advanceVisibility).toHaveBeenCalledExactlyOnceWith(organization);
    expect(transport.read).toHaveBeenCalledExactlyOnceWith(`task-key:${organization}:${taskKey}`);
    expect(registry.advanceVisibility.mock.invocationCallOrder[0]).toBeLessThan(
      transport.read.mock.invocationCallOrder[0] ?? 0,
    );
    expect(access.task.mock.calls).toEqual([
      [hidden.session, taskKey, signal],
      [restored.session, taskKey, signal],
    ]);
    expect(registry.evict).toHaveBeenCalledExactlyOnceWith(hidden.socketId, hidden.session, '5', {
      kind: 'task',
      taskKey,
    });
    expect(transport.leave).toHaveBeenCalledExactlyOnceWith(hidden, [
      room,
      `task-key:${organization}:${taskKey}`,
    ]);
    expect(transport.disconnect).not.toHaveBeenCalled();
  });

  it('evicts a permanently purged key without querying Task and retries an overlapped fence', async () => {
    const { connections, registry, transport, access } = fixture();
    const selected = recipient();
    transport.read.mockResolvedValue([selected]);
    registry.readFence.mockResolvedValueOnce('5').mockResolvedValueOnce('6');
    const signal = new AbortController().signal;

    await expect(
      connections.invalidateTaskRoom(organization, taskKey, 'purge', signal),
    ).rejects.toThrow('overlapped with a visibility change');
    expect(transport.leave).not.toHaveBeenCalled();
    registry.evict.mockResolvedValue(`task:${taskId}`);

    await connections.invalidateTaskRoom(organization, taskKey, 'purge', signal);

    expect(transport.leave).toHaveBeenCalledExactlyOnceWith(selected, [
      `task:${taskId}`,
      `task-key:${organization}:${taskKey}`,
    ]);
    expect(access.task).not.toHaveBeenCalled();
    expect(transport.disconnect).not.toHaveBeenCalled();
  });

  it('stops queued trash checks and never evicts after cancellation', async () => {
    const { connections, registry, transport, access } = fixture();
    const selected = recipient();
    transport.read.mockResolvedValue(
      Array.from({ length: 9 }, (_, index) => ({ ...selected, socketId: String(index) })),
    );
    const controller = new AbortController();
    access.task.mockImplementation(async () => {
      await Promise.resolve();
      controller.abort();
      return null;
    });

    await expect(
      connections.invalidateTaskRoom(organization, taskKey, 'trash', controller.signal),
    ).rejects.toThrow();

    expect(access.task).toHaveBeenCalledTimes(8);
    expect(registry.evict).not.toHaveBeenCalled();
  });
});
