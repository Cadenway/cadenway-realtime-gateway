/** Socket subscriptions may select their own organization, a list UUID or a Task key. */
export type RoomSelection =
  | { readonly kind: 'organization' }
  | { readonly kind: 'list'; readonly listId: string }
  | { readonly kind: 'task'; readonly taskKey: string };
