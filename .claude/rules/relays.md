---
paths:
  - 'src/modules/relays/**'
---

# Relays

- One relay per event family uses installed `@cadenway/contracts` payloads.
- Follow `cw-rooms-and-relays`: narrowest room, members only for private spaces. Send IDs and
  changed fields. Clients refetch through the API.
- In V2, put handlers in `src/modules/relays/presentation/messaging/handlers/<event-family>/`.
  Application selects the authorized audience and calls a publication port.

## Review example

For example, a private task update is sent to the authorized room with the changed fields.
Check that each eligible client receives the change and that sockets outside the room receive
nothing. For changes to fan-out, inspect whether payload size or work per recipient grows.
