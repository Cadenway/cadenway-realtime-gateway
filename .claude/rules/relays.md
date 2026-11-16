---
paths:
  - 'src/modules/relays/**'
---

# Relays

- One relay per event family; payloads from the installed `@cadenway/contracts`.
- Narrowest room first; private-space events reach that space's members only.
- Messages carry ids and changed fields; clients refetch details through the API.
- In the V2 layout, group handlers in `src/modules/relays/presentation/messaging/handlers/<event-family>/`. Application logic chooses the authorized audience and calls
  a publication port.
