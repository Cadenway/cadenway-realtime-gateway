# Connection

## Responsibilities

Receives incoming Socket.IO connections. The IO adapter checks Origin before the gateway receives
the handshake. The entry point reads the single-use ticket from `auth.token` and
passes it to Identity once. A successful redemption supplies the fixed account, membership,
organization, session version, and deadline for that socket. The socket rejoins through the full
handshake on every reconnection, without message replay.

Before creating a transport, Redis admits at most 24 attempts per source network and 240 per
cluster in a 10-second window. The private listener relies on Traefik as its sole proxy hop.
Each replica limits in-flight Redis admissions, ticket checks and open transports. Clients that
do not open a namespace in 15 seconds are closed. Incoming packets are limited to 8 KiB.

The gateway registers the verified organization and personal subscriptions, then rechecks the
registration before sending `connection.ready.v1`. It closes at the Identity deadline and removes
the registration on disconnect. Task and list subscriptions use strictly validated selectors. Task
access checks carry the verified user and organization, and a task room requires the stable UUID
reported by Task. A leave uses the socket's existing selector mapping, including when the resource
became hidden. One room change per socket can be in flight. Each socket may hold up to 32 list and
task subscriptions combined. The registry counts them atomically with the visibility check. Its
organization and personal subscriptions do not count. Rejoining a selection uses its existing
slot, and leaving frees one. An authorized request for a new selection at capacity receives
`room.limit-reached`.

## Adapters

- Identity redemption signs a system request without a tenant and disables retries. It maps
  only validated response data to the session model with the effective expiration in milliseconds.
  The ticket stays out of request URLs, logs, and trace attributes.
- Task access uses the socket's captured tenant and account for each check, validates the
  returned resource, and maps a missing or hidden resource to the same refusal.
- Redis registration checks and writes the session and membership fence atomically. A terminal
  session revocation, an organization change with a version greater than the socket version, a
  removed member, or a role mismatch prevents registration. Registration and room mappings expire
  at the Identity deadline. Invalidation writes the monotone marker before removing the affected
  registrations and disconnecting their sockets through the cross-instance adapter. Keep the
  marker long enough to cover any pending ticket registration or existing socket.
- The registry tracks the visibility epoch per organization. An access, placement, or lifecycle
  invalidation advances it. Subscriptions atomically compare the epoch read before Task checked
  access as well as the session and membership fences. The gateway checks again after applying
  the transport room membership. A Socket.IO room is a delivery index. Relays must check the
  still-valid recipient registration and current resource access before sending a notice.
- Connection explicitly imports Presence for socket lifecycle operations. Its local Redis
  subscription delivers presence snapshots only to the authorized sockets of this replica.
  Presence starts after admission has been checked. A heartbeat never extends the Identity
  session deadline. Each command verifies the lease before acknowledging its effect.
- `presence:list` returns one snapshot page of the socket's own organization. A first page is
  spaced by five seconds per socket, and a continuation accepts only the cursor returned by that
  socket's previous page. One list request per socket can be in flight, apart from heartbeats and
  status changes, within the replica's bound on presence operations. A page refused by Redis
  authority or followed by a failed lease recheck closes the socket.
- The gateway maintains private session and task-key indexes for control operations
  and recipient lookup across instances. The private `account:<organizationId>:<userId>` index,
  joined at handshake, finds the connections a personal notice names by account. The task-key index is written only after a stable Task UUID
  has been authorized. Redis verifies the exact lease, epoch and room while publishing a short-lived
  handoff to its owning replica. Only that replica rechecks the lease and emits to its own socket.
- Task notices use a private Socket.IO server event to read at most 32 ready recipients per
  replica at a time after `REALTIME_PAGED_RECIPIENTS_ENABLED=true`. The coordinator advances a shared cursor only past the socket IDs covered
  by every reply. An unavailable or incompatible replica leaves the broker delivery for retry.
  Each page still checks Task access and fences before publishing. Control-path invalidations
  advance their authoritative fences independently of notice delivery.
- The default discovery mode stays compatible with older replicas. Every new replica registers
  the page handler in either mode. Roll out page support everywhere, then enable paged discovery.
  Disable paged discovery on every replica before rolling back to a build without page support.
  Once enabled, an incomplete page fails the attempt even during version skew.
- Each replica admits up to 128 concurrent owner handoffs. At capacity it drops incoming handoffs
  without queueing and increments the OpenTelemetry counter
  `cadenway.realtime.relay.handoff.dropped` with no metric attributes. It exports this counter
  through the configured OTLP pipeline. The counter only measures drops observed by the inbox.
  Existing connections remain open and Redis Pub/Sub provides no replay. A client needs an
  independent API resynchronization path to recover a change it missed while connected.
- Admission needs the acknowledged private route. A connection checks its lease periodically, so
  a dropped cross-instance close hint cannot keep a revoked socket connected beyond the recheck.
  Bound local checks close affected sockets if Redis cannot resolve their lease within the deadline.
  Scope invalidations advance the visibility epoch and write only the changed resource's fence.
  Each resource-room registration records its authorized space and list. Redis deduplicates each
  producer fact, so its replay cannot close a more recent connection.

## Public entry points

| Entry point                               | Consumers |
| ----------------------------------------- | --------- |
| `public/connection/connection-recipients` | relays    |
| `connection.module`                       | relays    |
