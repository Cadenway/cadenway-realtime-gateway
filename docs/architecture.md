# Architecture and ownership

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

## Status

Connection redeems a single-use ticket with Identity, verifies the current Organization membership,
and uses Task as the visibility authority for resource subscriptions. It imports Presence for the
socket lifecycle and owns local delivery. Relays imports the Connection capability to resolve
recipients and apply invalidation fences for versioned broker facts.

## Runtime wiring

| File                                                                                  | Holds                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/telemetry.ts`                                                                    | `startTelemetry` of `@cadenway/nest-common/telemetry`, preloaded by the start command before `main.js`                                                                                                                                                                                 |
| `src/main.ts`                                                                         | Inside `runApplication`: validates the environment, creates the application, listens on `PORT`; a failed start-up is one JSON line on the standard error and exit code 1                                                                                                               |
| `src/realtime-application.ts`                                                         | `createApplication` with the options of a public gateway (signer only, no internal token verification, incoming `X-Request-Id` and `X-Request-Timeout-Ms` ignored), then `trust proxy` for one hop, `helmet`, CORS for `ALLOWED_ORIGINS` and the Socket.IO adapter                     |
| `src/app.module.ts`                                                                   | `ConfigModule` (validated when the application is created), the Redis module, `MessagingModule` (the NATS connection, no outbox, no stream management, no dead-letter worker), `HealthModule` with the Redis and NATS indicators and the shutdown delay, and the connection capability |
| `src/config/app-config.ts`                                                            | The zod schema of the environment                                                                                                                                                                                                                                                      |
| `src/infrastructure/redis/redis.module.ts`                                            | The main Redis connection, a `ResilientRedisClient` of `@cadenway/nest-common/redis`: readiness, outage logs, closed on shutdown; presence will use it                                                                                                                                 |
| `src/infrastructure/redis/redis-io.adapter.ts`                                        | The Socket.IO adapter: exact `Origin` check of every handshake, CORS of long-polling, fan-out through `@socket.io/redis-adapter` on the publisher and subscriber `createPubSubClients` derives from the main connection, closed on shutdown                                            |
| `src/modules/connection/connection.module.ts`                                         | The connection capability, imported by the root module to register its Socket.IO entry point                                                                                                                                                                                           |
| `src/modules/connection/presentation/websocket/gateways/realtime/realtime.gateway.ts` | The Socket.IO entry point redeems tickets, checks the registered lease and routes room and presence commands.                                                                                                                                                                          |

`src/infrastructure/redis/` sits outside the capabilities because the fan-out of
`src/modules/connection/` and the presence of `src/modules/presence/` share its connection, and because
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

cadenway-realtime-gateway pushes task and comment changes, presence, and optionally Git link
changes over WebSocket (`realtime.<domain>`). The local listener uses port 3001.

Planned event subscriptions include `task.*`, `comment.created`, `notification.created`, `reminder.due`, `git.*`, `user.status-changed`.

## Architectural ownership

Follow the [Cadenway NestJS architecture reference](https://github.com/Cadenway/cadenway-service-kit/blob/main/docs/hexagonal-architecture.md) for ports, adapters, dependency direction, naming and test placement.

- `src/modules/connection/`: handshake authentication, rooms.
- `src/modules/relays/`: one relay per event family.
- `src/modules/presence/`: presence in Redis.
- `src/infrastructure/redis/`: the Redis connection and the Socket.IO adapter they share.

### V2 capability layout

The realtime gateway uses the [V2 gateway
profile](https://github.com/Cadenway/cadenway-service-kit/blob/main/docs/hexagonal-architecture.md#realtime-gateway-profile).
See the [connection module](../src/modules/connection/MODULE.md) for the current implementation.

`connection` owns handshake authentication and room access, `relays` owns
event-to-audience orchestration, and `presence` owns presence policy. Put Socket.IO and NATS
entry points in `presentation/`, authorization and audience selection in `application/`, and
outgoing integrations in `infrastructure/`. Each capability has a root Nest module and
`MODULE.md` under `src/modules/`. Its entry points call use cases and its composition binds
outbound ports.

The shared Redis connection and Socket.IO adapter remain in `src/infrastructure/redis/` because
bootstrap registers them before application initialization. Upstream permission checks, presence
storage and room publication have distinct ports.

## Boundaries

- No database; Redis for presence and cross-instance fan-out.
- Events are consumed through `@cadenway/nest-messaging` only; payloads are those of the installed `@cadenway/contracts`.
- A client joins a room only after checking its organization and its right to the list or task.
- Exposed through Traefik on `realtime.<domain>` only.

## Cross-repository changes

Each checkout owns its implementation and release. Use published `@cadenway/*` packages instead of sibling source imports or local dependency links. For contract changes, make the contract and generated package available first, then update the producing service, gateways and listeners, and finally the webapp. Each step should remain deployable independently.

## Architecture checks

`pnpm test:architecture` runs the gateway profile from [`@cadenway/nest-testing`](https://github.com/Cadenway/cadenway-tooling) against this repository's TypeScript configuration. It runs locally as part of `pnpm quality` and in the GitHub Actions quality gate.
