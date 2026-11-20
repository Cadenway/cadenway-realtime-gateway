/** The server constructs room names only from verified session or resource identifiers. */
export type RealtimeRoom =
  `org:${string}` | `member:${string}` | `list:${string}` | `task:${string}`;
