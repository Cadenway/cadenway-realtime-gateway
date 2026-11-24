# Relays

## Purpose

Consumes the facts declared by the installed realtime contract and sends bounded,
recipient-authorized task and comment invalidations. Connection owns socket sessions and rooms.

## Public entry points

| Entry point | Consumers |
| ----------- | --------- |
| None        | None      |

## Owned data

None. Connection keeps expiring socket registrations and invalidation fences in Redis.

## API

The Socket.IO `change` packet follows `asyncapi/realtime-gateway.yaml`. A task packet carries
only a stable task ID and changed field names. A comment packet carries only task and comment IDs.

## Events consumed

Session revocation and organization switches, membership removal and role changes, space and list
visibility and deletion, task update, status, trash and purge, and comment creation use the
individual versioned durables in the published realtime contract.

The five Git branch, pull request and checks facts produce `git.links-changed.v1` notices.
Each notice carries only the current authorized task ID and uses browser protocol version 1.
The Git subscriptions start only when `REALTIME_GIT_RELAYS_ENABLED` is enabled after the
broker grants the realtime identity access to their durable consumers.

Notification's `notification.created.v1` and `reminder.due.v1` produce personal notices of the
same names, with the producer ID, time and version. An inbox notice has empty data; a reminder
notice carries only the reminder and task IDs. The handler reads them with the notification-service
validators of the installed contracts. The realtime contract declares these subscriptions from
`@cadenway/contracts` 0.40.0 with the same payload schemas; 0.39.0 already ships the validators.
The two durables, `relay-notification-created` and `relay-reminder-due`,
start only when `REALTIME_PERSONAL_NOTICES_ENABLED` is enabled after the broker grants them.

## Invariants

- A personal notice reaches only the ready connections authenticated as the fact's account in the
  fact's organization, through each connection's own `member:<memberId>` room. Each delivery
  checks the captured session, membership and visibility fence, then Task's current visibility of
  the subject as that account. Connections of the same session and role at the same fence share
  one decision. A subjectless inbox fact needs only the fence. A hidden subject or a missing
  membership withholds the notice; an unavailable decision fails the attempt for broker
  redelivery. A publication refused because the visibility epoch moved is authorized again at the
  new fence, up to three times before the attempt fails for redelivery.

- Each candidate socket is scoped to the producer organization and checked against a live session,
  a current Task visibility proof, matching task placement and an unchanged Redis fence.
- Task updates reach task and list subscribers once per socket. Comments reach task subscribers.
- Space, list and task placement changes advance the tenant visibility fence to reject in-flight
  proofs. Only sockets with an older subscription to the changed resource need to reconnect.
- Task trash and purge advance the tenant visibility fence and reconcile only the affected task
  subscriptions. A delayed trash fact keeps restored task subscriptions with current Task proof.
- A delayed fact whose task has moved is omitted without removing a still-authorized subscription.
- An unavailable visibility check fails the delivery for broker retry; no producer payload or
  hidden task content enters a broad organization room.
- The socket admission gate closes on broker or consumer unavailability. It reopens after the
  current broker connection confirms that the authorization invalidation durables have caught up
  and the persistent advisory stream is empty. Each replica checks the stream continuously and
  closes existing transports if the stream is unavailable, has a terminal advisory, or the last
  successful probe is stale. The advisory remains until an operator reconciles the authorities.
- Each relay processes at most eight recipient checks concurrently. Within each delivery batch,
  sockets of the same account, role and visibility fence share a successful Task proof.

## Transactions

The gateway owns no database transaction. Connection performs Redis fencing before transport
operations. JetStream redelivery can repeat an invalidation. Browsers deduplicate notices by ID.

## Decisions

Resource fences use the space and list returned by Task at subscription time. A move invalidates
the task subscription so the next join records its current placement. Task's current proof must
still match the producer's space and list before a relay is delivered.
With paged discovery enabled, each replica returns one bounded page of ready recipients to Connection.
The relay processes a page before requesting the next, so a large room cannot require one full-cluster
socket snapshot per notice. A missing page or invalid acknowledgement fails the broker attempt. Browser notifications
are volatile, and clients must refresh affected resources through the API after lost notifications.
