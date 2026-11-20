/** Task's current authorized identity and placement, resolved for one verified session. */
export interface TaskPlacement {
  // #region Properties
  /** Task identity and its current organization, space and list. */
  readonly organizationId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly spaceId: string;
  readonly listId: string;
  // #endregion
}
