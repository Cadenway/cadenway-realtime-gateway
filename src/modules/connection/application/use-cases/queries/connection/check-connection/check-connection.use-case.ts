/**
 * Class CheckConnection
 *
 * @description
 * Rejects incoming connections in the bootstrap shell until handshake authentication exists.
 */
export class CheckConnection {
  // #region Methods
  /**
   * Method execute
   *
   * @description
   * Determines whether an incoming connection can stay open.
   *
   * @returns {boolean} Whether the connection is accepted.
   */
  public execute(): boolean {
    return false;
  }
  // #endregion
}
