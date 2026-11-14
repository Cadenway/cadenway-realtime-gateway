# Architecture and ownership

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

## Status

The checkout contains a NestJS bootstrap and health endpoints. The following ownership map governs gateway capabilities as they are implemented.

## Purpose and target structure

cadenway-realtime-gateway will push changes to browsers over WebSocket (`realtime.<domain>`): a task changed by someone else, a new notification (inbox badge), a due reminder, a status change coming from GitHub, presence. Local port 3001.

Planned event subscriptions include `task.*`, `comment.created`, `notification.created`, `reminder.due`, `git.*`, `user.status-changed`.

## Architectural ownership

Follow the [Cadenway NestJS architecture reference](https://github.com/Cadenway/cadenway-service-kit/blob/main/docs/hexagonal-architecture.md) for ports, adapters, dependency direction, naming and test placement.

- `src/connection/`: handshake authentication, rooms.
- `src/relays/`: one relay per event family.
- `src/presence/`: presence in Redis.

## Boundaries

- No database; Redis for presence and cross-instance fan-out.
- Events are consumed through `@cadenway/nest-messaging` only; payloads are those of the installed `@cadenway/contracts`.
- A client joins a room only after checking its organization and its right to the list or task.
- Exposed through Traefik on `realtime.<domain>` only.

## Cross-repository changes

Each checkout owns its implementation and release. Use published `@cadenway/*` packages instead of sibling source imports or local dependency links. For contract changes, make the contract and generated package available first, then update the producing service, gateways and listeners, and finally the webapp. Each step should remain deployable independently.

## Architecture checks

`pnpm test:architecture` runs the gateway profile from [`@cadenway/nest-testing`](https://github.com/Cadenway/cadenway-tooling) against this repository's TypeScript configuration. It runs locally as part of `pnpm quality` and in the GitHub Actions quality gate.
