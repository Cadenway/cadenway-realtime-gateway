---
paths:
  - 'src/modules/presence/**'
---

# Presence

- Redis keys with TTL refreshed by heartbeats; invisible members appear offline.
- Presence changes go to the organization room only.
- In the V2 layout, application rules own expiry and visibility. Implement presence storage
  behind its own port. Reuse the shared Redis connection through an adapter under
  `infrastructure/`.
