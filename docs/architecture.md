# Architecture and ownership

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

## Status

At the time this documentation was written, this checkout has no `package.json`, application source tree, or GitHub workflow files. The target architecture, scripts, and workflows in this guide must be created and verified during bootstrap.

The following architecture is the target recorded in [AGENTS.md](../AGENTS.md). Paths and integrations are design boundaries, not evidence that files or services already exist.

## Purpose and target structure

cadenway-realtime-gateway will push changes to browsers over WebSocket (`realtime.<domain>`): a task changed by someone else, a new notification (inbox badge), a due reminder, a status change coming from GitHub, presence. Local port 3001.

Planned event subscriptions include `task.*`, `comment.created`, `notification.created`, `reminder.due`, `git.*`, `user.status-changed`.

## Architectural ownership

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
