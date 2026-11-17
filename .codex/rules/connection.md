---
paths:
  - 'src/modules/connection/**'
---

# Connections and rooms

- Close unauthenticated sockets immediately. Before authentication, `RedisIoAdapter`
  (`src/infrastructure/redis/`) returns 403 for a missing `Origin` or one outside
  `ALLOWED_ORIGINS`. Compare exactly and keep the check outside gateway decorators because
  browser CORS does not apply to the upgrade.
- Enforce API permissions for joining `list:<id>` or `task:<id>`. Use `org:<id>` for
  organization rooms. Leave all rooms on logout, organization switch, or token expiry.
- Follow [`cw-rooms-and-relays`](../skills/cw-rooms-and-relays/SKILL.md) for the single-use
  handshake ticket, personal room, envelope, revocation, and reconnection.
- Under V2, register Socket.IO entry points in `presentation/websocket/gateways/`. Application
  code owns ticket redemption, room authorization, and outbound ports.

## Review example

For example, reconnecting after a session ends must take the same authorization path as a fresh
connection. Test socket closure on revocation and avoid carrying the old organization's rooms
into a new connection.
