# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the target design from repository instructions and skills. Its behavior has not been verified as implemented in this snapshot.

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

The logger, the redaction list, the OpenTelemetry SDK, its
instrumentations and its exporters belong to `@cadenway/nest-common`: the gateway configures them and
installs no logging or telemetry library of its own. `pino-pretty` is the one exception, a
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
node --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import ./telemetry.js dist/main.js
```

- This is the only documented way while NestJS 12 imports Express as ESM. Node 24 marks
  `--experimental-loader` as discouraged: revisit the command with each Node or SDK upgrade.
- The flags go on the `node` start command (the `CMD` of the `Dockerfile`), not in application code.
- `OTEL_EXPORTER_OTLP_ENDPOINT` points to the collector; like `LOG_LEVEL`, it is validated at start-up
  and described in `.env.example`.

### Metrics

- Throughput, errors and duration per route, and the lag of each event consumer. The label is the
  route pattern or the consumer name, never a room, an id or a token.
- Exported over OTLP to the collector; no `prom-client`.
- The gateway has no outbox and no database pool: those metrics belong to the services.

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
