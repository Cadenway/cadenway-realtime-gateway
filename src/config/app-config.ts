import {
  baseConfigShape,
  internalTokenSignerConfigShape,
  type BaseConfig,
  type InternalTokenSignerConfig,
} from '@cadenway/nest-common';
import { redisConfigShape, type RedisConfig } from '@cadenway/nest-common/redis';
import { messagingConfigShape, type MessagingConfig } from '@cadenway/nest-messaging';
import { z } from 'zod';

/**
 * Interface AppConfig
 *
 * @description
 * Validated environment of the realtime gateway. Every value comes from the environment and is
 * checked once at start-up: a missing or invalid variable stops the process with a `ConfigError`
 * that names the variable and never prints its value.
 *
 * Besides the variables of every Cadenway backend (`NODE_ENV`, `PORT`, `LOG_LEVEL`, `LOG_PRETTY`),
 * the gateway signs the internal token of the calls it makes to cadenway-identity-service and
 * cadenway-task-service (`INTERNAL_TOKEN_ISSUER`, `INTERNAL_TOKEN_PRIVATE_JWK`) and verifies none:
 * it authenticates the sockets itself. The shapes of the kit validate the two connections:
 * `REDIS_URL` (`@cadenway/nest-common/redis`), the Redis that carries the fan-out of the Socket.IO
 * adapter between instances and, later, presence; `NATS_URL`, `NATS_USER` and `NATS_PASSWORD`
 * (`@cadenway/nest-messaging`), the broker the gateway will consume events from, as the NATS user
 * `realtime-gateway` of cadenway-ops.
 */
export interface AppConfig
  extends BaseConfig, InternalTokenSignerConfig, RedisConfig, MessagingConfig {
  // #region Properties
  /**
   * Property ALLOWED_ORIGINS
   *
   * @description
   * Browser origins allowed to open a socket, read from a comma-separated list such as
   * `https://app.cadenway.com`: the web application only. Each entry is an exact origin (scheme,
   * host and optional port; no path, no trailing slash, lowercase), never a wildcard. The
   * handshake compares `Origin` to this list by exact string equality, and CORS answers these
   * origins only.
   *
   * @type {readonly string[]}
   * @readonly
   */
  readonly ALLOWED_ORIGINS: readonly string[];

  /**
   * Property IDENTITY_SERVICE_URL
   *
   * @description
   * Base URL of cadenway-identity-service on the internal network, where the handshake ticket
   * will be redeemed.
   *
   * @type {string}
   * @readonly
   */
  readonly IDENTITY_SERVICE_URL: string;

  /**
   * Property TASK_SERVICE_URL
   *
   * @description
   * Base URL of cadenway-task-service on the internal network, where the right to join a list or
   * task room will be checked.
   *
   * @type {string}
   * @readonly
   */
  readonly TASK_SERVICE_URL: string;

  /** Enables Git event consumption after the broker grants the five named durables. */
  readonly REALTIME_GIT_RELAYS_ENABLED: boolean;
  // #endregion
}

/**
 * Function isExactOrigin
 *
 * @description
 * Tells whether a text is a serialized origin as a browser sends it in the `Origin` header: an
 * HTTP or HTTPS URL reduced to its scheme, host and port. The comparison with the parsed origin
 * refuses a path, a trailing slash, credentials, uppercase letters and a default port written out,
 * so that an allowed origin can only be compared by exact string equality.
 *
 * @param {string} text - One entry of `ALLOWED_ORIGINS`.
 * @returns {boolean} `true` when the text is an exact HTTP or HTTPS origin.
 */
function isExactOrigin(text: string): boolean {
  if (!URL.canParse(text)) {
    return false;
  }
  const url: URL = new URL(text);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === text;
}

/**
 * Constant serviceUrlSchema
 *
 * @description
 * Schema of a `<NAME>_SERVICE_URL` variable: an HTTP or HTTPS URL. The internal clients take their
 * base URL from it, never from code.
 *
 * @type {z.ZodType<string>}
 */
const serviceUrlSchema: z.ZodType<string> = z.url({
  protocol: /^https?$/u,
  error: 'Expected an http or https URL.',
});

/**
 * Constant allowedOriginsSchema
 *
 * @description
 * Schema of `ALLOWED_ORIGINS`: a comma-separated list of at least one exact origin. The messages
 * describe the expectation and never repeat the received text.
 *
 * @type {z.ZodType<readonly string[]>}
 */
const allowedOriginsSchema: z.ZodType<readonly string[]> = z
  .string()
  .transform((text: string): string[] => text.split(',').map((entry: string) => entry.trim()))
  .pipe(
    z
      .array(
        z
          .string()
          .refine(
            isExactOrigin,
            'Expected an exact origin such as https://app.example.com: http or https, no path, no trailing slash, lowercase, no wildcard.',
          ),
      )
      .min(1),
  );

/**
 * Constant appConfigSchema
 *
 * @description
 * Zod schema of the environment of the realtime gateway, for `loadConfig` and
 * `ConfigModule.forRoot`. `INTERNAL_TOKEN_ISSUER` and `INTERNAL_TOKEN_PRIVATE_JWK` keep the rules of
 * `@cadenway/nest-common`: a lowercase kebab-case name and one line of JSON holding an Ed25519
 * private JSON Web Key with its `kid`. `REDIS_URL` and the three NATS variables keep the rules of
 * the kit shapes; `NATS_USER` and `NATS_PASSWORD` are optional there, for an anonymous local broker
 * only: every broker of cadenway-ops, and the one of `compose.dev.yaml`, refuses a connection
 * without them. Git subscriptions are disabled by default.
 *
 * @type {z.ZodType<AppConfig>}
 */
export const appConfigSchema: z.ZodType<AppConfig> = z.object({
  ...baseConfigShape,
  ...internalTokenSignerConfigShape,
  ...redisConfigShape,
  ...messagingConfigShape,
  ALLOWED_ORIGINS: allowedOriginsSchema,
  IDENTITY_SERVICE_URL: serviceUrlSchema,
  TASK_SERVICE_URL: serviceUrlSchema,
  REALTIME_GIT_RELAYS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
