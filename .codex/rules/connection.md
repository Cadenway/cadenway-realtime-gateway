---
paths:
  - 'src/connection/**'
---

# Connections and rooms

- Authenticate at handshake; an unauthenticated socket is closed immediately.
- Rooms: `org:<id>`, `list:<id>`, `task:<id>`. Joining a list or task room checks the permission through
  the API's authorization contract.
- Leave every room on logout, organization switch or token expiry.
