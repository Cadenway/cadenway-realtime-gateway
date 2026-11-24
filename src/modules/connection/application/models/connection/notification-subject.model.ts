/** A Notification resource reference whose current visibility Task decides for one account. */
export type NotificationSubject =
  | { readonly kind: 'task-id'; readonly taskId: string }
  | { readonly kind: 'task-key'; readonly taskKey: string }
  | { readonly kind: 'list'; readonly listId: string }
  | { readonly kind: 'space'; readonly spaceId: string };
