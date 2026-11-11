# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the target design from repository instructions and skills. Its behavior has not been verified as implemented in this snapshot.

## Delivery boundaries

The gateway verifies the connection and room permissions, relays relevant events, and uses Redis for presence and cross-instance fan-out. Its event sources and rules are described in [AGENTS.md](../AGENTS.md). The room table below is a target design, not evidence of an implemented protocol.

## Rooms And Relays

Source: `wp-rooms-and-relays` ([Claude](../.claude/skills/wp-rooms-and-relays/SKILL.md), [Codex](../.codex/skills/wp-rooms-and-relays/SKILL.md)).

| Event                                 | Room                            | Message                    |
| ------------------------------------- | ------------------------------- | -------------------------- |
| `task.updated`, `task.status-changed` | `task:<id>` and `list:<listId>` | `{ taskId, changed }`      |
| `comment.created`                     | `task:<id>`                     | `{ taskId, commentId }`    |
| `notification.created`                | the member's personal room      | `{ unread }` (inbox badge) |
| `reminder.due`                        | the member's personal room      | `{ reminderId, taskId }`   |
| `git.*`                               | `task:<id>`                     | `{ taskId, link }`         |
| `user.status-changed`                 | `org:<id>`                      | `{ member, status }`       |

Private spaces: a member who is not part of the space never receives its task events, even in the
organization room.

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
