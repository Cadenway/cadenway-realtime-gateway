---
paths:
  - 'src/relays/**'
---

# Relays

- One relay per event family; payloads from the installed `@waypoint/contracts`.
- Narrowest room first; private-space events reach that space's members only.
- Messages carry ids and changed fields; clients refetch details through the API.
