# waypoint-realtime-gateway: Claude Code instructions

> **Source of truth.** This file is the entry point for Claude Code. The normative rules live in
> [AGENTS.md](AGENTS.md), imported below: read it, do not paraphrase it from memory.

@AGENTS.md

> **Read on demand, deliberately not `@`-imported**: `../waypoint-api-contracts/asyncapi/`, the [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Importing them would
> cost context in every session. The path-scoped rules in `.claude/rules/` load automatically when
> you open a matching file and carry the few things that must never be got wrong there.

## TL;DR for every task

1. The gateway pushes what changed; it never stores business data and never decides.
2. Connections authenticate at handshake with the session token; rooms are per organization, list and open task.
3. Relays map a broker event to a room message; only events the client may see are relayed.
4. Presence (online, away, do not disturb, invisible) lives in Redis with expiry.
5. Scale out through the Redis adapter; no in-memory state that a second instance would miss.

## Boundaries (hard rules)

- No database; Redis for presence and cross-instance fan-out.
- Events are consumed through `@waypoint/nest-messaging` only; payloads are those of the installed `@waypoint/contracts`.
- A client joins a room only after checking its organization and its right to the list or task.
- Exposed through Traefik on `realtime.<domain>` only.

## Target quality gate

Use the [minimum checks by change](docs/development.md#minimum-checks-by-change) first.
Run `/wp-quality` without arguments for the full local gate when applicable. Report unavailable
checks during bootstrap.

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm test:integration                    # Redis and NATS in Docker
pnpm build
docker compose -f compose.dev.yaml config -q
```



## Tooling: this repository ships its own `.claude/`

Open `waypoint-realtime-gateway/` as the workspace root to activate it. The `wp-rt-*` agents, the `/wp-*`
commands, the skills and the hooks are described in [.claude/README.md](.claude/README.md). Two things
the session listing does not tell you:

- **Rules** in `.claude/rules/` load at session start unless they declare `paths`. Scoped rules
  load when Claude reads a matching file.
- **Hooks** cover the edit and shell tool events matched in `.claude/settings.json`.
  `guard.mjs` refuses edits that break a hard rule
  (generated trees, lockfiles, secrets, sibling checkouts, direct NATS clients, unpinned third-party actions and `pull_request_target` in workflows), `guard-git.mjs`
  refuses pushes to `main`, tag pushes, force-pushes, rewrites of pushed commits, hook bypasses and
  registry publishing, and `format.mjs` formats supported files when its formatter is available.
  Apply the repository rules across tools. Resolve a refusal without bypassing the hook.

The sibling repositories (`../waypoint-api-contracts`, `../waypoint-service-kit`, `../waypoint-webapp`, `../waypoint-ops`) are read-only references
from here; add them to the session (`--add-dir`) when a task needs to read them.
