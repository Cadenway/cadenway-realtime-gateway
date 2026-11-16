---
name: cw-arch-review
description: Review boundaries.
---

Use the **cw-rt-architecture-reviewer** specialist for this task when delegation is available and authorized; otherwise read `.codex/agents/cw-rt-architecture-reviewer.toml` and follow its instructions directly: the user-provided arguments

The agent carries its own procedure and rules; do not restate them.

Review each connection, relay family and presence owner independently. Check that HTTP, NATS,
Socket.IO and Redis types stay at their respective boundaries, that room access is decided in
application code, and that bootstrap owns the shared transport adapter.
