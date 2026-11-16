---
description: "Review boundaries."
argument-hint: "[files]"
---

Delegate to the **cw-rt-architecture-reviewer** subagent: $ARGUMENTS

The agent carries its own procedure and rules; do not restate them.

Review each connection, relay family and presence owner independently. Check that HTTP, NATS,
Socket.IO and Redis types stay at their respective boundaries, that room access is decided in
application code, and that bootstrap owns the shared transport adapter.
