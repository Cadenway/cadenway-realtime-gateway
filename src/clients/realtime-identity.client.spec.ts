import { runWithOrganizationContext } from '@cadenway/nest-common';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  baseUrl,
  createInternalTransportFixture,
  orgId,
  session,
  userId,
} from '../../tests/support/realtime-private-client.fixture.js';
import { RealtimeIdentityClient } from './realtime-identity.client.js';

const fixtureTicket = '0'.repeat(43);
const memberId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31';
const sessionId = '019a6a2e-4b1c-7d3e-8f5a-2c9b7e1d4a60';
const confirmedHeaders = {
  'Cache-Control': 'no-store',
  'Preference-Applied': 'cadenway-saml-source-membership',
};
const redemption = (sessionExpiresAt = new Date(Date.now() + 60_000).toISOString()) => ({
  sessionId,
  sessionVersion: 5,
  userId,
  organizationId: orgId,
  memberId,
  role: 'member',
  sessionExpiresAt,
});

describe('RealtimeIdentityClient', () => {
  let upstream: Awaited<ReturnType<typeof createInternalTransportFixture>>;
  beforeAll(async () => {
    upstream = await createInternalTransportFixture('identity-service');
  });

  function identity(fetch: typeof globalThis.fetch): RealtimeIdentityClient {
    return new RealtimeIdentityClient(upstream.client(fetch));
  }

  it('consumes a ticket once with a system token and returns the verified current lease', async () => {
    const expected = redemption();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, options) => {
      const request = new Request(input, options);
      expect(request.url).toBe(`${baseUrl}/internal/v1/realtime/tickets/redemption`);
      expect(request.method).toBe('POST');
      expect(request.headers.get('prefer')).toBe('cadenway-saml-source-membership');
      expect(await request.json()).toEqual({ token: fixtureTicket });
      const principal = await upstream.verifier.verify(
        request.headers.get('authorization')?.slice(7) ?? '',
      );
      expect(principal).toMatchObject({
        actor: { type: 'system', id: null },
        organizationId: null,
        role: null,
        scopes: [],
      });
      return Response.json(expected, { headers: confirmedHeaders });
    });

    await expect(
      runWithOrganizationContext(
        {
          actor: { type: 'user', id: userId },
          organizationId: orgId,
          role: 'owner',
          scopes: ['tasks:read'],
        },
        () => identity(fetch).redeem(fixtureTicket),
      ),
    ).resolves.toEqual({
      ...session,
      memberId,
      sessionId,
      sessionVersion: 5,
      expiresAt: Date.parse(expected.sessionExpiresAt),
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('conceals an unknown ticket and does not send an invalid ticket', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const client = identity(fetch);
    await expect(client.redeem('short-ticket')).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.redeem(fixtureTicket)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['unreachable', 'unavailable'])(
    'does not replay redemption when Identity is %s',
    async (failure) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      if (failure === 'unreachable') fetch.mockRejectedValue(new TypeError('Disconnected.'));
      else fetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
      await expect(identity(fetch).redeem(fixtureTicket)).rejects.toThrow(
        'Identity ticket redemption is unavailable.',
      );
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    () => Response.json(redemption()),
    () => Response.json(redemption(), { status: 201, headers: { 'Cache-Control': 'no-store' } }),
    () =>
      new Response(JSON.stringify(redemption()), {
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' },
      }),
    () =>
      Response.json(
        { ...redemption(), token: fixtureTicket },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
    () =>
      new Response(`invalid JSON ${fixtureTicket}`, {
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
      }),
  ])('redacts invalid successful redemption replies', async (response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response());
    const result = identity(fetch).redeem(fixtureTicket);
    await expect(result).rejects.toThrow(/^Identity ticket redemption is unavailable\.$/u);
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('declines a redeemed session whose lease has expired', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json(redemption(new Date(0).toISOString()), {
        headers: confirmedHeaders,
      }),
    );
    await expect(identity(fetch).redeem(fixtureTicket)).resolves.toBeNull();
  });

  it('requires confirmation that Identity evaluated the negotiated SAML source binding', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(redemption(), { headers: { 'Cache-Control': 'no-store' } }),
      );
    await expect(identity(fetch).redeem(fixtureTicket)).rejects.toThrow(
      'Identity ticket redemption is unavailable.',
    );
  });
});
