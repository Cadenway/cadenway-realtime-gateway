---
name: cw-logging-and-tracing
description: "Log fields, redaction, trace propagation, the ESM start-up of OpenTelemetry and the metrics of cadenway-realtime-gateway. Load it before touching logging, tracing, metrics or the start command."
---

# Logging and tracing

The logger, the redaction list, the OpenTelemetry SDK, its instrumentations and its exporters
belong to `@cadenway/nest-common`: the gateway configures them and installs no logging or telemetry
library of its own. `createApplication` (called by `src/realtime-application.ts`) installs the logs,
and `src/telemetry.ts` starts the telemetry. `pino-pretty` is the one exception, a
development dependency for readable local output. Check what the installed kit exports before relying
on a name.

## Logs

- JSON lines from the logger of `@cadenway/nest-common`; never `console.log`.
- Fields: `service`, `version`, `traceId`, `spanId`, `organizationId`, `userId`, `route`, `status`,
  `durationMs`. `organizationId` and `userId` come from the verified handshake, never from a client
  message.
- Redaction: tokens, passwords and e-mail addresses are masked by the list of the kit. No e-mail
  address and no IP address at `info` level.
- The handshake ticket (`auth.token`) and message payloads never reach a log line.
- `LOG_LEVEL` sets the level; it is validated at start-up and described in `.env.example`.

## Traces

- W3C Trace Context: the `traceparent` of a consumed event is continued, and every HTTP call the
  gateway makes carries it.
- SQL values and query strings are excluded from spans.
- Spans come from the instrumentations of the kit (HTTP, Express, ioredis, undici) and its own NestJS
  interceptor. `@opentelemetry/instrumentation-nestjs-core` and `-router` stay out: the first does not
  support NestJS 12, the second doubles the spans under Express 5.

## Start-up (ESM)

The telemetry must be loaded before the application imports Express:

```text
node --max-old-space-size=160 --import @cadenway/nest-common/register --import ./dist/telemetry.js dist/main.js
```

- `@cadenway/nest-common/register` registers the module hooks of the instrumentations before
  `telemetry.js` loads them: hence the order of the two `--import`. The hooks are named through
  the kit: pnpm's strict `node_modules` does not expose `@opentelemetry/instrumentation` to the
  application. No `ExperimentalWarning` is printed, unlike `--experimental-loader`.
- `src/telemetry.ts` only calls `startTelemetry` of `@cadenway/nest-common/telemetry`, which
  imports no NestJS code.
- `--max-old-space-size=160` caps the old generation of the heap at about 60 % of the 256M
  container limit.
- The flags go on the `node` start command (the `CMD` of the `Dockerfile` and `pnpm start:dev`),
  not in application code.
- `OTEL_EXPORTER_OTLP_ENDPOINT` points to the collector; `startTelemetry` refuses anything but an
  HTTP or HTTPS URL, and unset, nothing is exported. It is described in `.env.example` and stays out
  of `deploy/compose.yaml` until an environment has a collector.
- The kit instruments ioredis: the commands of the Socket.IO adapter (`PUBLISH`, the
  subscriptions) and the readiness `PING` become spans.

## Metrics

- Throughput, errors and duration per route, and the lag of each event consumer. The label is the
  route pattern or the consumer name, never a room, an id or a token.
- Exported over OTLP to the collector; no `prom-client`.
- The gateway has no outbox and no database pool: those metrics belong to the services.
