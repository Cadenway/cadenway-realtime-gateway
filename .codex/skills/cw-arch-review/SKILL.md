---
name: cw-arch-review
description: Review boundaries.
---

Delegate the user's arguments to **cw-rt-architecture-reviewer** if delegation is available and authorized.
Otherwise read and follow `.codex/agents/cw-rt-architecture-reviewer.toml` directly with those arguments.
Do not restate its rules or procedure.

Review each connection, relay family and presence owner independently. Check that HTTP, NATS,
Socket.IO and Redis types stay at their respective boundaries, that room access is decided in
application code, and that bootstrap owns the shared transport adapter.
