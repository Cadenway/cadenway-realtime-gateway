import { describe, expect, it, vi } from 'vitest';

import type { PersonalRelayFact } from '../../../../models/relay/personal-relay-fact.model.js';
import type { PersonalRelayPort } from '../../../../ports/outbound/connection/relay/personal-relay.port.js';
import { RelayPersonalNotice } from './relay-personal-notice.use-case.js';

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
  id: 'event-a',
  organizationId: 'org-a',
  accountId: 'user-a',
  occurredAt: '2026-11-20T12:00:00Z',
  version: 3,
  type: 'notification.created.v1',
  subject: { kind: 'task-id', taskId: 'task-a' },
  data: {},
} satisfies PersonalRelayFact;

function setup() {
  const connections = {
    accountRecipients: vi
      .fn<PersonalRelayPort['accountRecipients']>()
      .mockResolvedValue([recipient]),
    fence: vi.fn<PersonalRelayPort['fence']>().mockResolvedValue('5'),
    subjectVisible: vi.fn<PersonalRelayPort['subjectVisible']>().mockResolvedValue(true),
    deliverPersonal: vi.fn<PersonalRelayPort['deliverPersonal']>().mockResolvedValue(true),
  } satisfies PersonalRelayPort;
  return { connections, relay: new RelayPersonalNotice(connections) };
}

describe('RelayPersonalNotice', () => {
  it('delivers the notice with each ready connection fence and excludes other accounts and organizations', async () => {
    const { connections, relay } = setup();
    const second = { ...recipient, socketId: 'socket-b' };
    connections.accountRecipients.mockResolvedValue([
      recipient,
      second,
      {
        ...recipient,
        socketId: 'other-org',
        session: { ...recipient.session, organizationId: 'org-b' },
      },
      { ...recipient, socketId: 'other-user', session: { ...recipient.session, userId: 'user-b' } },
    ]);
    const signal = new AbortController().signal;
    await relay.execute(fact, signal);
    expect(connections.accountRecipients).toHaveBeenCalledExactlyOnceWith('org-a', 'user-a');
    expect(connections.fence).toHaveBeenCalledTimes(2);
    const notice = {
      id: fact.id,
      type: fact.type,
      at: fact.occurredAt,
      version: fact.version,
      data: fact.data,
    };
    expect(connections.deliverPersonal).toHaveBeenCalledTimes(2);
    expect(connections.deliverPersonal).toHaveBeenCalledWith(recipient, '5', notice);
    expect(connections.deliverPersonal).toHaveBeenCalledWith(second, '5', notice);
  });

  it('skips a connection whose fence is unavailable without asking Task', async () => {
    const { connections, relay } = setup();
    connections.fence.mockResolvedValue(null);
    await relay.execute(fact, new AbortController().signal);
    expect(connections.subjectVisible).not.toHaveBeenCalled();
    expect(connections.deliverPersonal).not.toHaveBeenCalled();
  });

  it('delivers a subjectless notice without asking Task', async () => {
    const { connections, relay } = setup();
    await relay.execute({ ...fact, subject: null }, new AbortController().signal);
    expect(connections.subjectVisible).not.toHaveBeenCalled();
    expect(connections.deliverPersonal).toHaveBeenCalledOnce();
  });

  it('withholds a notice when its subject is hidden', async () => {
    const { connections, relay } = setup();
    connections.subjectVisible.mockResolvedValue(false);
    await relay.execute(fact, new AbortController().signal);
    expect(connections.deliverPersonal).not.toHaveBeenCalled();
  });

  it('shares decisions only for connections with the same role and fence', async () => {
    const { connections, relay } = setup();
    const same = { ...recipient, socketId: 'same' };
    const role = {
      ...recipient,
      socketId: 'role',
      session: { ...recipient.session, role: 'admin' as const },
    };
    const fence = { ...recipient, socketId: 'fence' };
    connections.accountRecipients.mockResolvedValue([recipient, same, role, fence]);
    connections.fence.mockImplementation((candidate) =>
      Promise.resolve(candidate.socketId === 'fence' ? '6' : '5'),
    );
    await relay.execute(fact, new AbortController().signal);
    expect(connections.subjectVisible).toHaveBeenCalledTimes(3);
    expect(connections.deliverPersonal).toHaveBeenCalledTimes(4);
  });

  it.each(['subjectVisible', 'deliverPersonal'] as const)(
    'rejects for broker retry when %s fails',
    async (operation) => {
      const { connections, relay } = setup();
      connections[operation].mockRejectedValue(new Error('unavailable'));
      await expect(relay.execute(fact, new AbortController().signal)).rejects.toThrow(
        'unavailable',
      );
    },
  );

  it('rejects an aborted fact before delivery', async () => {
    const { connections, relay } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(relay.execute(fact, controller.signal)).rejects.toThrow();
    expect(connections.accountRecipients).not.toHaveBeenCalled();
    expect(connections.deliverPersonal).not.toHaveBeenCalled();
  });
});
