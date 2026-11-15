# Architecture and ownership

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

## Status

The checkout contains the runtime wiring below and no capability yet: the Socket.IO entry point
closes every socket. The ownership map that follows governs gateway capabilities as they are
implemented.

## Runtime wiring

| File                                           | Holds                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/telemetry.ts`                             | `startTelemetry` of `@cadenway/nest-common/telemetry`, preloaded by the start command before `main.js`                                                                                                                                                                         |
| `src/main.ts`                                  | Inside `runApplication`: validates the environment, creates the application, listens on `PORT`; a failed start-up is one JSON line on the standard error and exit code 1                                                                                                       |
| `src/realtime-application.ts`                  | `createApplication` with the options of a public gateway (signer only, no internal token verification, incoming `X-Request-Id` and `X-Request-Timeout-Ms` ignored), then `trust proxy` for one hop, `helmet`, CORS for `ALLOWED_ORIGINS` and the Socket.IO adapter             |
| `src/app.module.ts`                            | `ConfigModule` (validated when the application is created), the Redis module, `MessagingModule` (the NATS connection, no outbox, no stream management, no dead-letter worker), `HealthModule` with the Redis and NATS indicators and the shutdown delay, the Socket.IO gateway |
| `src/config/app-config.ts`                     | The zod schema of the environment                                                                                                                                                                                                                                              |
| `src/infrastructure/redis/redis.module.ts`     | The main Redis connection, a `ResilientRedisClient` of `@cadenway/nest-common/redis`: readiness, outage logs, closed on shutdown; presence will use it                                                                                                                         |
| `src/infrastructure/redis/redis-io.adapter.ts` | The Socket.IO adapter: exact `Origin` check of every handshake, CORS of long-polling, fan-out through `@socket.io/redis-adapter` on the publisher and subscriber `createPubSubClients` derives from the main connection, closed on shutdown                                    |
| `src/connection/realtime.gateway.ts`           | The Socket.IO entry point; it closes every socket until handshake authentication exists                                                                                                                                                                                        |

`src/infrastructure/redis/` sits outside the capabilities because the fan-out of
`src/connection/` and the presence of `src/presence/` share its connection, and because
`src/realtime-application.ts` registers the adapter before the application initializes: a
start-up file may not import the files of a capability (`module-private` rule of
`pnpm test:architecture`).

Start command, in the `Dockerfile` and `pnpm start:dev`:

```text
node --max-old-space-size=160 --import @cadenway/nest-common/register --import ./dist/telemetry.js dist/main.js
```

Readiness answers 503 from the first moment of a stop, and the gateway keeps serving for
`SHUTDOWN_DELAY_MS` (3 seconds, `src/app.module.ts`) before it closes its listener and its sockets:
the GitOps agent stops the old container as soon as the new one is healthy, and Traefik may need
up to its 2 second provider throttle to route to the new one.

## Purpose and target structure

cadenway-realtime-gateway will push changes to browsers over WebSocket (`realtime.<domain>`): a task changed by someone else, a new notification (inbox badge), a due reminder, a status change coming from GitHub, presence. Local port 3001.

Planned event subscriptions include `task.*`, `comment.created`, `notification.created`, `reminder.due`, `git.*`, `user.status-changed`.

## Architectural ownership

Follow the [Cadenway NestJS architecture reference](https://github.com/Cadenway/cadenway-service-kit/blob/main/docs/hexagonal-architecture.md) for ports, adapters, dependency direction, naming and test placement.

- `src/connection/`: handshake authentication, rooms.
- `src/relays/`: one relay per event family.
- `src/presence/`: presence in Redis.
- `src/infrastructure/redis/`: the Redis connection and the Socket.IO adapter they share.

## Boundaries

- No database; Redis for presence and cross-instance fan-out.
- Events are consumed through `@cadenway/nest-messaging` only; payloads are those of the installed `@cadenway/contracts`.
- A client joins a room only after checking its organization and its right to the list or task.
- Exposed through Traefik on `realtime.<domain>` only.

## Cross-repository changes

Each checkout owns its implementation and release. Use published `@cadenway/*` packages instead of sibling source imports or local dependency links. For contract changes, make the contract and generated package available first, then update the producing service, gateways and listeners, and finally the webapp. Each step should remain deployable independently.

## Architecture checks

`pnpm test:architecture` runs the gateway profile from [`@cadenway/nest-testing`](https://github.com/Cadenway/cadenway-tooling) against this repository's TypeScript configuration. It runs locally as part of `pnpm quality` and in the GitHub Actions quality gate.
