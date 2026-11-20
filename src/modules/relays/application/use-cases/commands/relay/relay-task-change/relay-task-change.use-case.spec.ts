import { describe, expect, it, vi } from 'vitest';

import type { TaskRelayFact } from '../../../../models/relay/task-relay-fact.model.js';
import type { TaskRelayPort } from '../../../../ports/outbound/connection/relay/task-relay.port.js';
import { RelayTaskChange } from './relay-task-change.use-case.js';

const organizationId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const spaceId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30';
const listId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31';
const taskId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b32';
const id = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b33';
const recipient = {
  socketId: 'socket-a',
  session: {
    organizationId,
    memberId: id,
    userId: id,
    sessionId: id,
    sessionVersion: 1,
    expiresAt: Date.parse('2027-11-20T12:00:00Z'),
    role: 'member' as const,
  },
};
const fact = {
  id,
  organizationId,
  spaceId,
  listId,
  key: 'CAD-42',
  occurredAt: '2026-11-20T12:00:00Z',
  version: 3,
  type: 'task.updated.v1',
  data: { changed: ['name', 'status'] },
} satisfies TaskRelayFact;

function setup() {
  const connections = {
    taskSubscribers: vi.fn<TaskRelayPort['taskSubscribers']>().mockResolvedValue([recipient]),
    listSubscribers: vi.fn<TaskRelayPort['listSubscribers']>().mockResolvedValue([recipient]),
    fence: vi.fn<TaskRelayPort['fence']>().mockResolvedValue('5'),
    authorizeTask: vi.fn<TaskRelayPort['authorizeTask']>().mockResolvedValue({
      organizationId,
      spaceId,
      listId,
      taskId,
      taskKey: fact.key,
    }),
    deliver: vi.fn<TaskRelayPort['deliver']>().mockResolvedValue(true),
    evict: vi.fn<TaskRelayPort['evict']>().mockResolvedValue(undefined),
  };
  return { connections, relay: new RelayTaskChange(connections) };
}

describe('RelayTaskChange', () => {
  it('sends one minimal task notice to a socket subscribed through both rooms', async () => {
    const { relay, connections } = setup();
    const signal = new AbortController().signal;
    await relay.execute(fact, signal);
    expect(connections.authorizeTask).toHaveBeenCalledExactlyOnceWith(recipient, fact.key, signal);

    expect(connections.deliver).toHaveBeenCalledExactlyOnceWith(recipient, `task:${taskId}`, '5', {
      id,
      type: 'task.updated.v1',
      at: fact.occurredAt,
      version: 3,
      data: { taskId, changed: ['name', 'status'] },
    });
  });

  it('ignores a delayed fact for a moved task without evicting current subscriptions', async () => {
    const { relay, connections } = setup();
    connections.taskSubscribers.mockResolvedValue([
      recipient,
      {
        socketId: 'other',
        session: { ...recipient.session, organizationId: 'other-organization' },
      },
    ]);
    connections.listSubscribers.mockResolvedValue([]);
    connections.authorizeTask.mockResolvedValue({
      organizationId,
      spaceId,
      listId: 'another-list',
      taskId,
      taskKey: fact.key,
    });
    await relay.execute(fact, new AbortController().signal);
    expect(connections.deliver).not.toHaveBeenCalled();
    expect(connections.evict).not.toHaveBeenCalled();
    expect(connections.fence).toHaveBeenCalledTimes(1);
  });

  it('evicts a denied task subscription while keeping the list subscription', async () => {
    const { relay, connections } = setup();
    connections.authorizeTask.mockResolvedValue(null);
    await relay.execute(fact, new AbortController().signal);
    expect(connections.deliver).not.toHaveBeenCalled();
    expect(connections.evict).toHaveBeenCalledExactlyOnceWith(
      recipient,
      { kind: 'task', taskKey: fact.key },
      '5',
    );
  });

  it('does not evict a list after a task-specific refusal', async () => {
    const { relay, connections } = setup();
    connections.taskSubscribers.mockResolvedValue([]);
    connections.authorizeTask.mockResolvedValue(null);
    await relay.execute(fact, new AbortController().signal);
    expect(connections.deliver).not.toHaveBeenCalled();
    expect(connections.evict).not.toHaveBeenCalled();
  });

  it('bounds concurrent access checks while delivering to every authorized socket', async () => {
    const { relay, connections } = setup();
    const recipients = Array.from({ length: 18 }, (_, index) => ({
      ...recipient,
      socketId: `socket-${String(index)}`,
      session: { ...recipient.session, userId: `user-${String(index)}` },
    }));
    connections.taskSubscribers.mockResolvedValue(recipients);
    connections.listSubscribers.mockResolvedValue([]);
    let active = 0;
    let peak = 0;
    connections.authorizeTask.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { organizationId, spaceId, listId, taskId, taskKey: fact.key };
    });
    await relay.execute(fact, new AbortController().signal);
    expect(peak).toBe(8);
    expect(connections.deliver).toHaveBeenCalledTimes(18);
  });

  it('shares an allowed Task lookup for sockets of the same account and role', async () => {
    const { relay, connections } = setup();
    connections.taskSubscribers.mockResolvedValue([
      recipient,
      { ...recipient, socketId: 'socket-b' },
    ]);
    connections.listSubscribers.mockResolvedValue([]);
    await relay.execute(fact, new AbortController().signal);
    expect(connections.authorizeTask).toHaveBeenCalledTimes(1);
    expect(connections.deliver).toHaveBeenCalledTimes(2);
  });

  it('does not share an earlier authorization across different visibility fences', async () => {
    const { relay, connections } = setup();
    const second = { ...recipient, socketId: 'socket-b' };
    connections.taskSubscribers.mockResolvedValue([recipient, second]);
    connections.listSubscribers.mockResolvedValue([]);
    let releaseOldProof!: () => void;
    const oldProofPending = new Promise<void>((resolve) => {
      releaseOldProof = resolve;
    });
    let oldProofStarted!: () => void;
    const oldProofStartedPromise = new Promise<void>((resolve) => {
      oldProofStarted = resolve;
    });
    connections.fence.mockImplementation(async (socket) => {
      if (socket.socketId === second.socketId) {
        await oldProofStartedPromise;
        return '6';
      }
      return '5';
    });
    connections.authorizeTask.mockImplementation(async (socket) => {
      if (socket.socketId === second.socketId) return null;
      oldProofStarted();
      await oldProofPending;
      return { organizationId, spaceId, listId, taskId, taskKey: fact.key };
    });
    const pending = relay.execute(fact, new AbortController().signal);
    await oldProofStartedPromise;
    // Let the second fence and its authorization run while the earlier proof is pending.
    await vi.waitFor(() => {
      expect(connections.fence).toHaveBeenCalledTimes(2);
    });
    releaseOldProof();
    await pending;
    expect(connections.authorizeTask).toHaveBeenCalledTimes(2);
    expect(connections.deliver).not.toHaveBeenCalledWith(
      second,
      expect.anything(),
      '6',
      expect.anything(),
    );
    expect(connections.evict).toHaveBeenCalledWith(
      second,
      { kind: 'task', taskKey: fact.key },
      '6',
    );
  });

  it('rechecks another socket when the shared authorization result is refused', async () => {
    const { relay, connections } = setup();
    const second = { ...recipient, socketId: 'socket-b' };
    connections.taskSubscribers.mockResolvedValue([recipient, second]);
    connections.listSubscribers.mockResolvedValue([]);
    connections.authorizeTask
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ organizationId, spaceId, listId, taskId, taskKey: fact.key });
    await relay.execute(fact, new AbortController().signal);
    expect(connections.authorizeTask).toHaveBeenCalledTimes(2);
    expect(connections.evict).toHaveBeenCalledExactlyOnceWith(
      recipient,
      { kind: 'task', taskKey: fact.key },
      '5',
    );
    expect(connections.deliver).toHaveBeenCalledTimes(1);
  });

  it('does not relay after invalidation or an authorization failure', async () => {
    const { relay, connections } = setup();
    connections.fence.mockResolvedValue(null);
    await relay.execute(fact, new AbortController().signal);
    expect(connections.authorizeTask).not.toHaveBeenCalled();
    expect(connections.deliver).not.toHaveBeenCalled();
  });

  it('sends a comment identifier only to task subscribers', async () => {
    const { relay, connections } = setup();
    const comment: TaskRelayFact = { ...fact, type: 'comment.created.v1', data: { commentId: id } };
    await relay.execute(comment, new AbortController().signal);
    expect(connections.listSubscribers).not.toHaveBeenCalled();
    expect(connections.deliver).toHaveBeenCalledExactlyOnceWith(
      recipient,
      `task:${taskId}`,
      '5',
      expect.objectContaining({ data: { taskId, commentId: id } }),
    );
  });

  it('propagates a failed visibility check for broker redelivery', async () => {
    const { relay, connections } = setup();
    connections.authorizeTask.mockRejectedValue(new Error('Task unavailable'));
    await expect(relay.execute(fact, new AbortController().signal)).rejects.toThrow(
      'Task unavailable',
    );
    expect(connections.deliver).not.toHaveBeenCalled();
  });
});
