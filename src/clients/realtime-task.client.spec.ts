import { runWithOrganizationContext } from '@cadenway/nest-common';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  baseUrl,
  createInternalTransportFixture,
  orgId,
  session,
  userId,
} from '../../tests/support/realtime-private-client.fixture.js';
import { RealtimeTaskClient } from './realtime-task.client.js';

const spaceId = '019a7000-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const listId = '019a7001-2b3c-7d4e-8f5a-6b7c8d9e0f12';
const taskId = '019a7002-3c4d-7e5f-8a6b-7c8d9e0f1a23';
const taskKey = 'CAD-482';
const taskLocation = { spaceId, listId, taskKey, role: 'edit' };
const freshSession = () => ({ ...session, expiresAt: Date.now() + 60_000 });

describe('RealtimeTaskClient', () => {
  let upstream: Awaited<ReturnType<typeof createInternalTransportFixture>>;
  beforeAll(async () => {
    upstream = await createInternalTransportFixture('task-service');
  });

  function task(fetch: typeof globalThis.fetch): RealtimeTaskClient {
    return new RealtimeTaskClient(upstream.client(fetch));
  }

  it('checks both room kinds with the signed session user and canonical placement', async () => {
    const otherTenant = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b99';
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, options) => {
      const request = new Request(input, options);
      expect(request.method).toBe('GET');
      const principal = await upstream.verifier.verify(
        request.headers.get('authorization')?.slice(7) ?? '',
      );
      expect(principal).toMatchObject({
        actor: { type: 'user', id: userId },
        organizationId: orgId,
        role: 'member',
        scopes: [],
      });
      if (request.url === `${baseUrl}/internal/v1/lists/${listId}/access`) {
        return Response.json({ role: 'view', spaceId, listId, taskKey: null });
      }
      expect(request.url).toBe(`${baseUrl}/internal/v1/tasks/${taskKey}/access`);
      return Response.json({ ...taskLocation, taskId: taskId.toUpperCase() });
    });
    const client = task(fetch);
    const authenticated = freshSession();
    await runWithOrganizationContext(
      { actor: { type: 'system', id: null }, organizationId: otherTenant, role: null, scopes: [] },
      async () => {
        await expect(client.list(authenticated, listId.toUpperCase())).resolves.toEqual({
          organizationId: orgId,
          listId,
          spaceId,
        });
        await expect(client.task(authenticated, taskKey)).resolves.toEqual({
          organizationId: orgId,
          listId,
          spaceId,
          taskKey,
          taskId,
        });
      },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('conceals missing resources and refuses mismatched or legacy proofs', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ...taskLocation, listId: taskId, taskKey: null }))
      .mockResolvedValueOnce(Response.json({ ...taskLocation, listId, taskKey: null, taskId }))
      .mockResolvedValueOnce(Response.json({ ...taskLocation, taskKey: 'CAD-483', taskId }))
      .mockResolvedValueOnce(Response.json(taskLocation));
    const client = task(fetch);
    const authenticated = freshSession();
    await expect(client.list(authenticated, listId)).resolves.toBeNull();
    await expect(client.list(authenticated, listId)).resolves.toBeNull();
    await expect(client.list(authenticated, listId)).resolves.toBeNull();
    await expect(client.task(authenticated, taskKey)).resolves.toBeNull();
    await expect(client.task(authenticated, taskKey)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('avoids upstream requests for malformed room selectors and expired sessions', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = task(fetch);
    await expect(client.list(freshSession(), 'not-a-list')).resolves.toBeNull();
    await expect(client.task(freshSession(), 'not-a-task')).resolves.toBeNull();
    await expect(
      client.task({ ...session, expiresAt: Date.now() - 1 }, taskKey),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['list', listId],
    ['task', taskKey],
  ] as const)('cancels an in-flight %s check without retrying it', async (kind, id) => {
    const controller = new AbortController();
    const reason = new DOMException('Relay deadline reached.', 'AbortError');
    let sawCallerCancellation = false;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, options) => {
      controller.abort(reason);
      sawCallerCancellation = options?.signal?.reason === reason;
      return Promise.reject(reason);
    });

    await expect(task(fetch)[kind](freshSession(), id, controller.signal)).rejects.toThrow(
      'Task room authorization is unavailable.',
    );
    expect(sawCallerCancellation).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects an already-cancelled check before sending it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const reason = new DOMException('Relay deadline reached.', 'AbortError');

    await expect(task(fetch).task(freshSession(), taskKey, AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discards a valid proof returned while the caller cancels', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Relay deadline reached.', 'AbortError');
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
      controller.abort(reason);
      return Promise.resolve(Response.json({ ...taskLocation, taskId }));
    });

    await expect(task(fetch).task(freshSession(), taskKey, controller.signal)).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
