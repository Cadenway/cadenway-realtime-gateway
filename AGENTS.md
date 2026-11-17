# cadenway-realtime-gateway: agent instructions

These rules apply to all assistants. [CLAUDE.md](CLAUDE.md) imports them for Claude Code.
Explicit user instructions take precedence over procedures, never over the hard limits below.

## First read

- Read `../cadenway-api-contracts/asyncapi/` for each relayed event.
- Read `package.json` for current versions and scripts. Keep version details there.
- Consult the [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N) for gateway
  ownership and the applicable local rules or skills for the files in scope.

## What this repository is

The WebSocket gateway pushes changes to browsers on `realtime.<domain>` without storing
business data or making domain decisions. See the [target architecture](docs/architecture.md#purpose-and-target-structure)
for the local port and planned event subscriptions. Check the checkout for implemented features
and available commands.

## Language

- Everything written in the repository is **English**: code, comments, docs, agent prompts, rules,
  skills, commit messages, branch names, PR titles and descriptions.
- Follow the user's language in the conversation only. No emojis.
- Never invent facts about the product, the contracts, the mockup or the tooling: cite the file or
  the document. When something does not exist yet, say so and say which step of the start-up plan
  brings it.

## Architectural ownership

Use the [V2 gateway profile](https://github.com/Cadenway/cadenway-service-kit/blob/main/docs/hexagonal-architecture.md#realtime-gateway-profile)
for new or reorganized capabilities and the [local capability map](docs/architecture.md#architectural-ownership)
for current ownership. Capabilities live under `src/modules/` with a root Nest module and
`MODULE.md`. Transport entry points call use cases. Bind distinct outbound ports in
`<module>.module.ts` or `composition/`. Shared Redis and the Socket.IO adapter stay in
`src/infrastructure/redis/`.

Use the scoped connection, relay, and presence rules. Handshake uses a single-use ticket valid
for 60 seconds, issued through the API gateway and redeemed at cadenway-identity-service.
Use organization, list, and task rooms with authorized audiences. Store presence (online,
away, do not disturb, invisible) in Redis with expiry. Scale out through the Redis adapter.
Keep state needed by multiple instances out of instance memory.

## Boundaries (hard rules)

- No database; Redis for presence and cross-instance fan-out.
- Events are consumed through `@cadenway/nest-messaging` only; payloads are those of the installed `@cadenway/contracts`.
- A client joins a room only after checking its organization and its right to the list or task.
- Exposed through Traefik on `realtime.<domain>` only.

## GitHub files (`.github/`)

Follow the scoped GitHub rule for `.github/` ownership, workflows, community files, and
matching shared content across repository pull requests. [`.github/README.md`](.github/README.md)
is the home page. Keep Renovate configuration local and complete without a shared preset.

## Code quality

- Read the affected entry point, its callers, and its relevant tests before editing.
  Preserve the behavior callers rely on unless the task changes it.
- Keep the diff focused. Use names that express intent and reuse existing code when
  it preserves the required behavior. Extract code when it clarifies a responsibility.
- Keep business decisions with their owning module. Validate external inputs at the
  boundary and use documented public interfaces across modules and repositories.
- For writes that can fail, overlap, or be retried, verify the resulting state.
  Check transaction boundaries, tenant scope, and repeated delivery where relevant.
- For collections and repeated work, check what grows with input size. Measure or
  inspect the bottleneck before adding an index, cache, worker, or replica.
- Run the repository checks that cover the affected behavior. Report the commands
  and their results, including checks that did not run and tests that selected zero cases.

## Commands and quality gates

Start with the [minimum checks by change](docs/development.md#minimum-checks-by-change).
Use its canonical script names, starting with the narrowest relevant check. See the
[full local quality gate](docs/development.md#full-local-quality-gate) for the ordered suite,
focused test syntax, and reporting rules shared by Codex and Claude.

## Git and branch flow

Follow [collaboration and release](docs/development.md#collaboration-and-release) and the
Git and commits rule for branch names, Conventional Commits, squash merges, and CI releases.
Stage only task files and preserve concurrent edits.

## Hard limits (never without the user's explicit request in this conversation)

- Never push to `main`, merge into it locally, create or push Git tags, or bump a version by hand.
- Never run a registry publish (`npm publish`, `pnpm publish`): this repository ships as a Docker image built by CI.
- Never force-push, and never amend or rebase commits that are already pushed.
- Never bypass the Git hooks (`--no-verify`, `core.hooksPath` overrides, `ALLOW_MAIN_PUSH=1`,
  `CW_SKIP_PUSH_CHECKS=1`).
- Never write a token, password or private key anywhere; `.npmrc` keeps `${NODE_AUTH_TOKEN}`. Do
  not read or write secret environment files; new variables are documented in `.env.example`.
- Never edit generated trees (`dist/`, `node_modules/`, `coverage/`) or lockfiles by hand.
- Never modify a sibling checkout (`../cadenway-*`) from a task in this repository.

The agent hooks enforce most of these mechanically; a refused command is a signal to stop and ask,
not to find another way around it.

## Agent tooling

Use the specialist and command inventories in the [Claude guide](.claude/README.md) and
[Codex guide](.codex/README.md). Builders edit assigned files. Reviewers work read-only.
Specialists are optional. Delegate bounded work with explicit files and checks, assign disjoint
files to parallel agents, and integrate their results.

## Repository hygiene

Reuse existing commands, tooling, and test infrastructure. Prefer inline commands or task
temporary directories for one-offs. Keep permanent scripts only for reusable gaps and add tests
for meaningful behavior or regressions in the existing test structure. Review untracked files
before delivery and clean up only current-task artifacts. Explain each new permanent tooling file.
Report material failures, skipped checks, and limitations. Ask only when missing information or
authorization blocks the dependent work.

## References

- [Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et) and
  [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N) (living documents).
