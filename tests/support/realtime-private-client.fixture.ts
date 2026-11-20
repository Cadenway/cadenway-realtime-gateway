import { generateKeyPairSync } from 'node:crypto';

import {
  InternalHttpClient,
  InternalTokenSigner,
  InternalTokenVerifier,
} from '@cadenway/nest-common';

export const baseUrl = 'http://service.test';
export const orgId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
export const userId = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30';
export const session = { organizationId: orgId, userId, role: 'member' as const };

export async function createInternalTransportFixture(service: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { d, x } = privateKey.export({ format: 'jwk' });
  const publicX = publicKey.export({ format: 'jwk' }).x;
  if (d === undefined || x === undefined || publicX === undefined) throw new Error('Missing key.');
  const key = { kty: 'OKP' as const, crv: 'Ed25519' as const, kid: 'test-realtime', x: publicX };
  const issuer = 'realtime-gateway';
  const [signer, verifier] = await Promise.all([
    InternalTokenSigner.create({ issuer, privateJwk: { ...key, x, d } }),
    InternalTokenVerifier.create({ audience: service, trustedIssuers: { [issuer]: [key] } }),
  ]);
  return {
    verifier,
    client: (fetch: typeof globalThis.fetch): InternalHttpClient =>
      new InternalHttpClient({ service, baseUrl, signer, fetch }),
  };
}
