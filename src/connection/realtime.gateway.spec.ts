import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RealtimeGateway } from './realtime.gateway.js';

describe('RealtimeGateway', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ providers: [RealtimeGateway] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('closes a socket immediately while handshake authentication does not exist', async () => {
    const socket = io(url, { transports: ['websocket'], reconnection: false });

    const reason = await new Promise<string>((resolve, reject) => {
      socket.once('disconnect', resolve);
      socket.once('connect_error', reject);
    });

    expect(reason).toBe('io server disconnect');
  });
});
