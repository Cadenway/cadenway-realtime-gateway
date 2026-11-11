---
name: wp-tech-websocket
description: "Implement or review WebSocket connections, rooms, event relays, or live updates in Waypoint."
---

# Websocket for Waypoint

The realtime gateway owns authenticated connections, rooms, presence and relays; the webapp consumes its public realtime interface. Read the relevant AsyncAPI contracts and existing `wp-rooms-and-relays` or realtime conventions before changing behavior. Respect organization and room authorization, connection cleanup, expiry and cross-instance state; validate reconnection and event handling with targeted tests when the infrastructure is available.

Consult the official documentation for the version actually used: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API.
