/** The resource whose current visibility a personal notice requires, as Notification names it. */
export type PersonalNoticeSubject =
  | { readonly kind: 'task-id'; readonly taskId: string }
  | { readonly kind: 'task-key'; readonly taskKey: string }
  | { readonly kind: 'list'; readonly listId: string }
  | { readonly kind: 'space'; readonly spaceId: string };
