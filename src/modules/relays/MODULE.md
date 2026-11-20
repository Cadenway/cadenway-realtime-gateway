# Relays

## Purpose

Consumes the fifteen facts declared by the installed realtime contract and sends bounded,
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

## Invariants

- Each candidate socket is scoped to the producer organization and checked against a live session,
  a current Task visibility proof, matching task placement and an unchanged Redis fence.
- Task updates reach task and list subscribers once per socket. Comments reach task subscribers.
- A permission or lifecycle change advances the tenant fence before conservatively closing its
  affected organization's sockets. A new connection obtains a fresh Identity ticket.
- A delayed fact whose task has moved is omitted without removing a still-authorized subscription.
- An unavailable visibility check fails the delivery for broker retry; no producer payload or
  hidden task content enters a broad organization room.
- The socket admission gate closes on broker or consumer unavailability. It reopens after the
  current broker connection confirms that the authorization invalidation durables have caught up.
- Each relay processes at most eight recipient checks concurrently. Within each batch, sockets of
  the same account and role share a successful Task proof while retaining individual Redis fences.

## Transactions

The gateway owns no database transaction. Connection performs Redis fencing before transport
operations. JetStream redelivery can repeat an invalidation. Browsers deduplicate notices by ID.

## Decisions

Space and list changes close tenant connections until a narrower reconciliation index is available.
For task placement changes, Task's current proof must match the producer's space and list.
Connection currently enumerates the full cluster room before the relay processes these batches.
