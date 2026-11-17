---
description: "Review boundaries."
argument-hint: "[files]"
---

Delegate to subagent **cw-rt-architecture-reviewer** without restating its rules or procedure: $ARGUMENTS

Review each connection, relay family and presence owner independently. Check that HTTP, NATS,
Socket.IO and Redis types stay at their respective boundaries, that room access is decided in
application code, and that bootstrap owns the shared transport adapter.
