# Presence

This capability maintains the verified membership's visible presence across gateway instances.
Socket leases use a 90-second heartbeat window and never extend the Identity session deadline.
The first socket makes a member visible. The last disconnection or expiration makes it offline.
Invisible is a private preference and is emitted as offline. Members and leases are partitioned by
organization. Redis publishes a transition only on that organization's private presence channel.

Presence changes verify the socket registration and current session, membership and tenant lease
in the same Redis script that updates the preference or publishes a transition. A revoked or
expired socket can still have its presence lease removed. A Redis subscription bridge validates
each organization-scoped transition and passes the common
`user.status-changed.v1` envelope to Connection for delivery to valid local sockets. Each instance
delivers to its own sockets to avoid a duplicate cross-instance broadcast. Its acknowledged
subscription is an admission prerequisite and loss of the connection closes local transports.
A recurring worker calls `expire` in bounded pages. Neither a Redis channel nor cached presence
grants access to an organization.

Redis keeps an index of the earliest expiring member lease. Updates prune expired sockets and
reconcile the visible state in the same script as the publication. The same script maintains the
organization's snapshot index: a sorted set of members whose visible status is not offline, all at
score zero so it orders by member ID, and a hash of each member's visible status and last lease
expiry. A snapshot page reads at most 100 members after a member ID cursor in the script that
verifies the socket authority, omits leases already expired before the sweep and returns the
caller's own preference, the only place where invisible appears. Members online before this index
existed appear after their next heartbeat. Member state remains for one
day after its last lease so an expiry worker can report offline after a short outage. Transitions
use Redis pub/sub and are therefore transient. Clients must refresh presence on reconnect.

A socket can issue one presence operation at a time. Heartbeats are spaced by at least five
seconds. Explicit status changes are spaced by a second per membership, across sockets and
replicas, with a budget of 24 changes per tenant per second. Redis checks that budget before
updating the preference. Each replica bounds the number of simultaneous presence operations and
fan-out deliveries. A busy operation returns `realtime.unavailable` without closing the socket.

## Public entry points

| Entry point                       | Consumers  |
| --------------------------------- | ---------- |
| `public/presence/manage-presence` | connection |
| `presence.module`                 | connection |

Connection imports this module for presence state and owns the delivery bridge. An explicit
admission gate remains closed until the Redis subscription is acknowledged.
