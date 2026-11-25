import { describe, expect, it, vi } from 'vitest';

import type { ListTasksRelayPort } from '../../../../ports/outbound/connection/relay/list-tasks-relay.port.js';
import { RelayConnectionsAdapter } from '../../../../../infrastructure/adapters/connection/relay/relay-connections.adapter.js';
import { RelayListTasks } from './relay-list-tasks.use-case.js';

const recipient = {
  socketId: 'socket-a',
  session: {
    organizationId: 'org-a',
    userId: 'user-a',
    memberId: 'member-a',
    sessionId: 'session-a',
    sessionVersion: 1,
    expiresAt: Date.parse('2027-11-20T12:00:00Z'),
    role: 'member' as const,
  },
};
const fact = {
  id: '019a7005-6f7a-7b8c-9d0e-1f2a3b4c5d51',
  organizationId: 'org-a',
  listId: '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f12',
};
const signal = new AbortController().signal;

function setup() {
  const connections = {
    listTasksNoticeId: vi
      .fn<ListTasksRelayPort['listTasksNoticeId']>()
      .mockImplementation((id) => new RelayConnectionsAdapter({} as never).listTasksNoticeId(id)),
    listSubscribers: vi
      .fn<ListTasksRelayPort['listSubscribers']>()
      .mockImplementation(async function* () {
        await Promise.resolve();
        yield [
          recipient,
          { ...recipient, session: { ...recipient.session, organizationId: 'org-b' } },
        ];
      }),
    fence: vi.fn<ListTasksRelayPort['fence']>().mockResolvedValue('fence'),
    authorizeList: vi.fn<ListTasksRelayPort['authorizeList']>().mockResolvedValue(true),
    deliverListTasks: vi.fn<ListTasksRelayPort['deliverListTasks']>().mockResolvedValue(true),
  } satisfies ListTasksRelayPort;
  return { connections, relay: new RelayListTasks(connections) };
}

describe('RelayListTasks', () => {
  it('sends the contract example with a stable derived id, current time and protocol version only to the list organization', async () => {
    const { connections, relay } = setup();
    const before = Date.now();
    await relay.execute(fact, signal);
    await relay.execute(fact, signal);
    expect(connections.listSubscribers).toHaveBeenCalledWith('org-a', fact.listId, signal);
    expect(connections.authorizeList).toHaveBeenCalledTimes(2);
    expect(connections.authorizeList).toHaveBeenCalledWith(recipient, fact.listId, signal);
    expect(connections.deliverListTasks).toHaveBeenCalledTimes(2);
    const notices = connections.deliverListTasks.mock.calls.map((call) => call[3]);
    for (const notice of notices) {
      expect(notice).toEqual({
        id: 'f780e4c6-ffdd-5c26-9f98-2f2494099eb8',
        type: 'list.tasks-changed.v1',
        at: notice.at,
        version: 1,
        data: { listId: fact.listId },
      });
      expect(Date.parse(notice.at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(notice.at)).toBeLessThanOrEqual(Date.now());
    }
    expect(connections.deliverListTasks).toHaveBeenCalledWith(
      recipient,
      fact.listId,
      'fence',
      notices[0],
    );
  });

  it('suppresses a denied recipient', async () => {
    const { connections, relay } = setup();
    connections.authorizeList.mockResolvedValue(false);
    await relay.execute(fact, signal);
    expect(connections.deliverListTasks).not.toHaveBeenCalled();
  });

  it('rejects an unavailable decision for broker redelivery', async () => {
    const { connections, relay } = setup();
    connections.authorizeList.mockRejectedValue(new Error('unavailable'));
    await expect(relay.execute(fact, signal)).rejects.toThrow('unavailable');
    expect(connections.deliverListTasks).not.toHaveBeenCalled();
  });

  it('reauthorizes after a fence race and rejects repeated races', async () => {
    const { connections, relay } = setup();
    connections.deliverListTasks.mockResolvedValue(false);
    await expect(relay.execute(fact, signal)).rejects.toThrow('racing');
    expect(connections.authorizeList).toHaveBeenCalledTimes(3);
  });
});
