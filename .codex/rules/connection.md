---
paths:
  - 'src/connection/**'
---

# Connections and rooms

- Authenticate at handshake; an unauthenticated socket is closed immediately.
- Rooms: `org:<id>`, `list:<id>`, `task:<id>`. Joining a list or task room checks the permission through
  the API's authorization contract.
- Leave every room on logout, organization switch or token expiry.
- The handshake credential is a single-use ticket valid 60 seconds, read from `auth.token`.
- The personal room is `member:<id>`; a socket joins the room of its authenticated member only.
- Messages leave in the envelope `{ id, type, at, version, data }`.
- On `session.revoked`, `member.removed` or a role change, close the sockets concerned.
- No connection state recovery (incompatible with the Redis adapter): the client rejoins its rooms
  and refetches.
