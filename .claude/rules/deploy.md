---
paths:
  - 'Dockerfile'
  - 'deploy/**'
  - 'compose.dev.yaml'
  - '.env.example'
---

# Deployment files

- The release workflow checks and copies `deploy/compose.yaml` to
  `cadenway-ops/environments/<env>/services/realtime-gateway.yaml`. Keep Traefik labels for
  `realtime.<domain>` there. Join `edge` (`cadenway-edge-${ENVIRONMENT}`) and `internal`.
- Declare every variable in `.env.example` with a working local value and keep secrets in
  cadenway-ops (SOPS). Leave `INTERNAL_TOKEN_PRIVATE_JWK` empty and document how to generate it.
  Never commit a private key, including a development key.
- Match `deploy/compose.yaml` environment entries to cadenway-ops `docs/service-environment.md`.
  Add new variables on the hosts before releasing a dependent entry. `@cadenway/nest-messaging`
  reads `NATS_URL`, `NATS_USER`, and `NATS_PASSWORD`.
- The `CMD` caps the heap and preloads the telemetry: `node --max-old-space-size=160 --import
  @cadenway/nest-common/register --import ./dist/telemetry.js dist/main.js`; `pnpm start:dev`
  runs the same flags.
- Use authenticated NATS in every environment, including `compose.dev.yaml` with the cadenway-ops
  `realtime-gateway` user (`nats/nats-server.conf`) and `EVENTS` stream.
- Use `/health/ready` for healthchecks, an explicit memory limit, a non-root user, and a pinned base
  image. Local port: 3001.
- Mount credentials for private `@cadenway/*` packages only during install, as the `npmrc` build secret.
  Never use `ARG`, `ENV`, or a copied file.
