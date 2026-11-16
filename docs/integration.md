# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the design from repository instructions and skills. The handshake
origin check, the Redis fan-out, the logs and the telemetry start-up are implemented and covered by
`tests/realtime-gateway.int-spec.ts`; the handshake ticket, the rooms, the relays, the revocation
and presence are not built yet.

## Delivery boundaries

The gateway verifies the connection and room permissions, relays relevant events, and uses Redis for presence and cross-instance fan-out. Its event sources and rules are described in [AGENTS.md](../AGENTS.md). The room table below is a target design, not evidence of an implemented protocol.

## Rooms And Relays

Source: `cw-rooms-and-relays` ([Claude](../.claude/skills/cw-rooms-and-relays/SKILL.md), [Codex](../.codex/skills/cw-rooms-and-relays/SKILL.md)).

| Event                                 | Room                            | Message                    |
| ------------------------------------- | ------------------------------- | -------------------------- |
| `task.updated`, `task.status-changed` | `task:<id>` and `list:<listId>` | `{ taskId, changed }`      |
| `comment.created`                     | `task:<id>`                     | `{ taskId, commentId }`    |
| `notification.created`                | the member's personal room      | `{ unread }` (inbox badge) |
| `reminder.due`                        | the member's personal room      | `{ reminderId, taskId }`   |
| `git.*`                               | `task:<id>`                     | `{ taskId, link }`         |
| `user.status-changed`                 | `org:<id>`                      | `{ member, status }`       |

Private spaces: a member who is not part of the space never receives its task events, even in the
organization room.

### Personal room

The member's personal room is `member:<id>`. A socket joins the room of its authenticated member
only.

### Envelope

Every message leaves in the envelope `{ id, type, at, version, data }`. The Message column of the
table is `data`.

### Handshake origin

Browsers apply no CORS to a WebSocket upgrade, so the gateway checks `Origin` itself before
anything else: `RedisIoAdapter` (`src/infrastructure/redis/redis-io.adapter.ts`) answers 403 to a
handshake, WebSocket or long-polling, whose `Origin` is not exactly one of `ALLOWED_ORIGINS` or that
has none. `ALLOWED_ORIGINS` holds the web application only (`app.<domain>`); the long-polling
transport answers CORS for the same origins, with credentials. The client bundle is not served.

### Fan-out

`@socket.io/redis-adapter` carries what an instance broadcasts to the others, over a publisher and a
subscriber opened from the options of the main Redis connection under their own names
(`realtime-gateway-publisher`, `realtime-gateway-subscriber`). Their commands wait for the
connection while Redis is unreachable, at start-up or during an outage, and readiness answers 503
meanwhile; the adapter sends its commands without handling their promises, so the clients settle
each one themselves rather than let a failure stop the process. Both close on shutdown, before the
main connection.

### Handshake ticket

The client authenticates with a single-use ticket valid 60 seconds, passed in `auth.token`. A ticket
that is unknown, expired or already used closes the socket.

### Revocation

The gateway listens to `session.revoked`, `member.removed` and role changes, and closes the sockets
concerned.

### Reconnection

No connection state recovery: it is incompatible with the Redis adapter in place. After a
reconnection the client rejoins its rooms and refetches through the API; the gateway replays
nothing.

## Logging And Tracing

Source: `cw-logging-and-tracing` ([Claude](../.claude/skills/cw-logging-and-tracing/SKILL.md), [Codex](../.codex/skills/cw-logging-and-tracing/SKILL.md)).

The logger, the redaction list, the OpenTelemetry SDK, its instrumentations and its exporters
belong to `@cadenway/nest-common`: the gateway configures them and installs no logging or telemetry
library of its own. `createApplication` (called by `src/realtime-application.ts`) installs the logs,
and `src/telemetry.ts` starts the telemetry. `pino-pretty` is the one exception, a
development dependency for readable local output. Check what the installed kit exports before relying
on a name.

### Logs

- JSON lines from the logger of `@cadenway/nest-common`; never `console.log`.
- Fields: `service`, `version`, `traceId`, `spanId`, `organizationId`, `userId`, `route`, `status`,
  `durationMs`. `organizationId` and `userId` come from the verified handshake, never from a client
  message.
- Redaction: tokens, passwords and e-mail addresses are masked by the list of the kit. No e-mail
  address and no IP address at `info` level.
- The handshake ticket (`auth.token`) and message payloads never reach a log line.
- `LOG_LEVEL` sets the level; it is validated at start-up and described in `.env.example`.

### Traces

- W3C Trace Context: the `traceparent` of a consumed event is continued, and every HTTP call the
  gateway makes carries it.
- SQL values and query strings are excluded from spans.
- Spans come from the instrumentations of the kit (HTTP, Express, ioredis, undici) and its own NestJS
  interceptor. `@opentelemetry/instrumentation-nestjs-core` and `-router` stay out: the first does not
  support NestJS 12, the second doubles the spans under Express 5.

### Start-up (ESM)

The telemetry must be loaded before the application imports Express:

```text
node --max-old-space-size=160 --import @cadenway/nest-common/register --import ./dist/telemetry.js dist/main.js
```

- `@cadenway/nest-common/register` registers the module hooks of the instrumentations with
  `module.register()`, before `telemetry.js` loads them: hence the order of the two `--import`.
  The hooks are named through the kit: pnpm's strict `node_modules` does not expose
  `@opentelemetry/instrumentation` to the application. Nothing is written on the standard error,
  unlike the former `--experimental-loader` form.
- `src/telemetry.ts` only calls `startTelemetry` of `@cadenway/nest-common/telemetry`, which
  imports no NestJS code.
- `--max-old-space-size=160` caps the old generation of the heap at about 60 % of the 256M limit
  of `deploy/compose.yaml`, so the garbage collector reclaims it before the container reaches
  its limit.
- The flags go on the `node` start command (the `CMD` of the `Dockerfile` and `pnpm start:dev`),
  not in application code.
- `OTEL_EXPORTER_OTLP_ENDPOINT` points to the collector; `startTelemetry` refuses anything but an
  HTTP or HTTPS URL, and unset, nothing is exported. It is described in `.env.example` and stays out
  of `deploy/compose.yaml` until an environment has a collector.
- The kit instruments ioredis: the commands of the Socket.IO adapter (`PUBLISH`, the
  subscriptions) and the readiness `PING` become spans.

### Metrics

- Throughput, errors and duration per route, and the lag of each event consumer. The label is the
  route pattern or the consumer name, never a room, an id or a token.
- Exported over OTLP to the collector; no `prom-client`.
- The gateway has no outbox and no database pool: those metrics belong to the services.

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
