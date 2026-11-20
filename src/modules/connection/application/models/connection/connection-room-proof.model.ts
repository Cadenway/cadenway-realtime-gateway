/** Task's current placement for an authorized list or task. */
export interface ConnectionRoomProof {
  // #region Properties
  /** Verified list and space, returned by Task. */
  readonly listId: string;
  readonly spaceId: string;

  /** Stable UUID and canonical key when the selected resource is a task. */
  readonly taskId?: string;
  readonly taskKey?: string;
  // #endregion
}
