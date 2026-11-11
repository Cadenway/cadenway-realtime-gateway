# waypoint-realtime-gateway: Claude Code tooling

This `.claude/` folder ships the Claude Code tooling of waypoint-realtime-gateway: **9 agents**,
10 slash commands, 9 rules, 14 skills, 3 hooks, the project
settings and launch configuration. The application launch requires the planned package scripts.

Start from [AGENTS.md](../AGENTS.md) (the rules every assistant follows) and [CLAUDE.md](../CLAUDE.md)
(the Claude entry point).

## Settings (`settings.json`)

- **Hooks** are wired through `${CLAUDE_PROJECT_DIR}` so they resolve from any working directory:
  `guard.mjs` before every `Write` / `Edit` / `MultiEdit`, `guard-git.mjs` before every `Bash` /
  `PowerShell` command, and `format.mjs` after matching edit events for supported files.
  Apply the repository rules across tools.
- **Permissions** allow specific repository commands and read-only Git commands. The project
  denies `Read` on `.env` and `.env.*`. Follow the repository secret-handling rules across tools.
  The project does not pre-approve `git push`, `gh` writes or arbitrary shell commands.
- **Fast mode is off** (`fastMode: false` and `CLAUDE_CODE_DISABLE_FAST_MODE=1`). Agent models and
  efforts are explicit in each agent's frontmatter; do not silently substitute a model.
- **MCP**: `enabledMcpjsonServers` enables `context7` from the root `.mcp.json`.
- **No plugins** are enabled (`enabledPlugins: {}`). The folder is itself a plugin
  (`.claude-plugin/plugin.json`, `hooks/hooks.json`) for installations outside this checkout.

## Working with the sibling repositories

Start from this checkout and attach the peers you need, for example:

```powershell
claude --add-dir ../waypoint-api-contracts ../waypoint-service-kit ../waypoint-webapp
```

Their `.claude/agents/` are discovered too, so their `wp-*` roles become available. Peer checkouts
are **read-only** from a waypoint-realtime-gateway session (the guard refuses edits there): change them in their
own session and pull request.

## Agents

Builders write only assigned files, inherit permissions and preserve concurrent work. Reviewers are
read-only: their tools exclude `Edit` and `Write`, and they ask the parent for the output of any
check that writes files. No agent delegates further.

| Agent | Responsibility | Model | Effort | Mode |
| --- | --- | --- | --- | --- |
| `wp-rt-connection-builder` | Handshake auth and rooms. | opus | high | Assigned writes |
| `wp-rt-relay-builder` | Map broker events to room messages. | sonnet | high | Assigned writes |
| `wp-rt-presence-builder` | Presence in Redis. | sonnet | medium | Assigned writes |
| `wp-rt-test-writer` | Connection, relay and presence tests. | sonnet | high | Assigned writes |
| `wp-rt-deploy-maintainer` | Deployment files and Traefik labels. | sonnet | medium | Assigned writes |
| `wp-rt-security-auditor` | Handshake, room access, data exposure. | opus | xhigh | Read-only |
| `wp-rt-performance-reviewer` | Fan-out, backpressure, memory. | sonnet | high | Read-only |
| `wp-rt-architecture-reviewer` | No business data, contract-first events. | opus | high | Read-only |
| `wp-rt-github-maintainer` | Workflows, templates and community files in .github/. | sonnet | medium | Assigned writes |

## Commands

| Command | What it does | Runs |
| --- | --- | --- |
| `/wp-connection` | Change handshake auth or rooms. | `wp-rt-connection-builder` |
| `/wp-relay` | Add or change a relay. | `wp-rt-relay-builder` |
| `/wp-presence` | Change presence. | `wp-rt-presence-builder` |
| `/wp-tests` | Write tests. | `wp-rt-test-writer` |
| `/wp-deploy` | Change deployment files. | `wp-rt-deploy-maintainer` |
| `/wp-security-review` | Audit connections and rooms. | `wp-rt-security-auditor` |
| `/wp-perf-review` | Review fan-out and memory. | `wp-rt-performance-reviewer` |
| `/wp-arch-review` | Review boundaries. | `wp-rt-architecture-reviewer` |
| `/wp-github` | Change workflows, templates or community files in .github/. | `wp-rt-github-maintainer` |
| `/wp-quality` | Run the local quality gate, stopping at the first failure. | runs the commands itself |

## Rules

| File | Subject | Loads for |
| --- | --- | --- |
| `connection.md` | Connections and rooms | `src/connection/**` |
| `relays.md` | Relays | `src/relays/**` |
| `presence.md` | Presence | `src/presence/**` |
| `tests.md` | Tests | `**/*.spec.ts`, `test/**` |
| `deploy.md` | Deployment files | `Dockerfile`, `deploy/**`, `compose.dev.yaml`, `.env.example` |
| `language.md` | Language | always |
| `git-and-commits.md` | Git and commits | always |
| `comments.md` | Comments and docblocks | `src/**/*.ts` |
| `github.md` | GitHub files | `.github/**` |

## Skills

See [skills/](skills/) for the complete inventory, including the technology guides.

| Skill | Use |
| --- | --- |
| `wp-context` | What Waypoint is, where the mockup, the integration guide and the repository map live, the product vocabulary (spaces, lists, sprints, tasks, statuses, milestones) and the multi-repository ownership rules. |
| `wp-rooms-and-relays` | Room naming, join permissions and the event-to-room mapping of the realtime gateway, with the visibility rule for private spaces. |

## Hooks

| Hook | When | What it refuses or does |
| --- | --- | --- |
| `guard.mjs` | before `Write`, `Edit` or `MultiEdit` | Sibling checkouts, generated trees, lockfiles, `.git/`, secrets and tokens, direct NATS clients, unpinned third-party actions and `pull_request_target` in workflows. |
| `guard-git.mjs` | before `Bash` or `PowerShell` | Pushes to `main`, tag pushes, force-pushes, rewrites of pushed commits, hook bypasses, destructive resets, registry publishing, branch names outside `<type>/<kebab>`. Adapted from the dentalstock guard. |
| `format.mjs` | after a successful `Write`, `Edit` or `MultiEdit` | Formats supported files with the repository's Prettier; a no-op until the formatter is installed. |
