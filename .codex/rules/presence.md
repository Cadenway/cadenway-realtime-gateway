---
paths:
  - 'src/modules/presence/**'
---

# Presence

- Refresh Redis key TTLs on heartbeat. Show invisible members as offline and publish changes
  only to the organization room.
- In V2, keep expiry and visibility in application code. Reuse shared Redis behind a presence
  storage port and an `infrastructure/` adapter.
