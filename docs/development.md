# Development and verification

[Documentation index](README.md) · [Repository overview](../.github/README.md) · [Repository instructions](../AGENTS.md)

## Status

The gateway runs on the shared runtime of `@cadenway/nest-common`, answers the health routes and
accepts Socket.IO handshakes from the web application only, then closes every socket: no
authentication, room, relay, presence or event consumer exists yet (see the
[documentation index](README.md)). The scripts and checks below exist in `package.json` and CI.
Run Git, pnpm, build, and test commands with this repository as the working directory, never from
the parent workspace.

## Before making a change

- `../cadenway-api-contracts/asyncapi/` for every event you relay.
- The [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N), section "cadenway-realtime-gateway".
- `package.json` for versions and scripts once the repository is bootstrapped. Do not restate
  versions elsewhere: a copy goes stale.

## Setup

Requirements: Node.js LTS and pnpm (versions in `package.json`), and Docker.

1. Clone this repository next to the other Cadenway repositories, flat, in one folder.
2. To run it with the rest of Cadenway, start the stack from `cadenway-ops`; it builds the sibling
   folders. The planned `full` profile includes this service:

   ```bash
   cd ../cadenway-ops/compose
   docker compose -f compose.yaml -f compose.local.yaml --profile full up -d
   ```

3. To work on this repository alone:

   ```bash
   pnpm install
   cp .env.example .env
   docker compose -f compose.dev.yaml up -d   # Redis and NATS
   pnpm start:dev                             # http://localhost:3001, reads .env
   ```

   The gateway refuses to start until `INTERNAL_TOKEN_PRIVATE_JWK` holds an Ed25519 private key,
   and no key is committed, not even a development one. Generate one from `cadenway-ops`:

   ```bash
   cd ../cadenway-ops/compose
   cp .env.example .env        # once, if it is not there yet: it names compose.local.yaml
   docker compose run --rm internal-token-keys --print
   ```

   It prints a fresh pair per issuer on the terminal and writes nothing. Put the value of
   `REALTIME_GATEWAY_INTERNAL_TOKEN_PRIVATE_JWK` into `INTERNAL_TOKEN_PRIVATE_JWK` of `.env`,
   between single quotes.

Every variable is validated at start-up: a missing or invalid one stops the process with a
`ConfigError` that names it and never prints its value. `.env.example` describes each of them.
A browser page opens a socket only from an origin listed in `ALLOWED_ORIGINS`; add the address of
a local web application server there.

## Minimum checks by change

The scripts below are this repository's contract. While the repository is being bootstrapped,
create them with these exact names; afterwards, use them and never an ad-hoc equivalent. Run the
narrowest check that covers the change first, then widen:

| Changed                         | Minimum check                                        |
| ------------------------------- | ---------------------------------------------------- |
| Relays or rooms                 | `pnpm test src/relays` or `pnpm test src/connection` |
| Presence                        | `pnpm test:integration presence`                     |
| Any source                      | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`   |
| Docs or agent instructions only | Scoped formatting and link review                    |

Report the commands you actually ran and their results; a check you did not run is reported as not
run.

## Full check list

`pnpm quality` runs the commands below except the integration tests and the Compose check; CI runs
all of them on each pull request, and builds the image. Run `/cw-quality` in Claude Code or
`$cw-quality` in Codex without arguments.

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:architecture
pnpm test:coverage
pnpm test:integration                    # disposable Redis in Docker
pnpm build
docker compose -f compose.dev.yaml config -q
```

## Collaboration and release

- Trunk-based: work branches come from `main`, named `<type>/<lowercase-kebab-description>` with a
  type among `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
  `revert`; put the Cadenway task id first when there is one (`feat/cad-482-sso-screen`). Never an
  agent name as a prefix. Validate with `git check-ref-format --branch <name>`.
- Commits and PR titles follow Conventional Commits: `type(scope): subject`, English, imperative,
  lowercase subject, no trailing period, at most 100 characters; `!` only for a breaking change.
- Pull requests target `main` and are squash-merged after review and green CI. release-please opens the release pull request; its merge tags, publishes the image and lets the deploy workflow write the version into cadenway-ops.
- Stage only the files of your task; preserve other people's changes in the working tree.

Keep credentials, private keys, decrypted environment files and Terraform state out of documentation and logs. Follow the hard limits in [AGENTS.md](../AGENTS.md); setup instructions do not authorize deployments or changes to real infrastructure.
