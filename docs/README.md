# cadenway-realtime-gateway documentation

Planned role: cadenway-realtime-gateway pushes changes to browsers over WebSocket (`realtime.<domain>`): a task changed by someone else, a new notification (inbox badge), a due reminder, a status change coming from GitHub, presence. Local port 3001.

## Current status

The gateway runs on the shared runtime of `@cadenway/nest-common`: validated configuration, JSON
logs, OpenTelemetry, `application/problem+json` errors, the internal token signer, the public-edge
HTTP settings (security headers, one trusted proxy hop, CORS for the web application) and the
health routes, whose readiness checks Redis. Socket.IO runs on a Redis adapter that fans out
between instances and refuses a handshake from any origin but the web application. Every socket
that passes is still closed at once: handshake authentication (the single-use ticket redeemed at
cadenway-identity-service), rooms, relays and presence do not exist yet, nor the event consumers,
which arrive with `@cadenway/nest-messaging`. The target architecture in this guide is what they
must follow.

## Read the guides

- [Architecture and ownership](architecture.md): boundaries and planned repository structure.
- [Development and checks](development.md): prerequisites, planned commands and verification.
- [Domain and integration](integration.md): repository-specific contracts, behavior and dependencies.

## Sources and policy

- [Repository overview](../.github/README.md) and [contribution guide](../.github/CONTRIBUTING.md).
- [Repository instructions and hard limits](../AGENTS.md).
- [Claude Code instructions](../CLAUDE.md) and [tooling](../.claude/README.md).
- [Codex tooling](../.codex/README.md).
- [Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N).

Repository instructions take precedence over this summary. Refer to the actual package manifests, implementation, specifications, and workflows once they exist; do not infer a deployed feature from a target design.
