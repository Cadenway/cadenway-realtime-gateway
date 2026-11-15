import type { INestApplicationContext } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { RedisIoAdapter } from './redis-io.adapter.js';

/**
 * Constant adapter
 *
 * @description
 * Adapter allowing the web application only. Neither the application nor the Redis connection is
 * used before `createIOServer`, so empty stand-ins are enough for the origin check.
 *
 * @type {RedisIoAdapter}
 */
const adapter: RedisIoAdapter = new RedisIoAdapter({} as INestApplicationContext, {} as Redis, [
  'https://app.cadenway.test',
]);

describe('RedisIoAdapter', () => {
  it('accepts the exact origin of the web application', () => {
    expect(adapter.isAllowedOrigin('https://app.cadenway.test')).toBe(true);
  });

  it.each([
    ['no origin', undefined],
    ['another site', 'https://evil.test'],
    ['a lookalike that starts with the allowed origin', 'https://app.cadenway.test.evil.test'],
    ['the website', 'https://cadenway.test'],
    ['another scheme', 'http://app.cadenway.test'],
    ['a trailing slash', 'https://app.cadenway.test/'],
    ['uppercase letters', 'https://APP.cadenway.test'],
    ['an explicit default port', 'https://app.cadenway.test:443'],
    ['the opaque origin of a sandboxed document', 'null'],
  ])('refuses %s', (_label: string, origin: string | undefined) => {
    expect(adapter.isAllowedOrigin(origin)).toBe(false);
  });
});
