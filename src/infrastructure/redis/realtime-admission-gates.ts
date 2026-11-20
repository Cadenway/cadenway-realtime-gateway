import { Injectable } from '@nestjs/common';

const required = ['broker-relays', 'owner-inbox', 'presence'] as const;
type GateName = (typeof required)[number];

/** Admission requires all private delivery and invalidation subscriptions to be usable. */
@Injectable()
export class RealtimeAdmissionGates {
  // #region Properties
  /** Readiness of each required transport input. */
  private readonly gates = new Map<GateName, () => boolean>();

  /** Local transport owners close their sockets when any input loses readiness. */
  private readonly listeners = new Set<() => void>();

  /** Checks every required gate at the moment of admission. */
  public get ready(): boolean {
    return required.every((name) => this.gates.get(name)?.() === true);
  }
  // #endregion

  // #region Methods
  /** Registers the single owner of one required subscription. */
  public track(
    name: GateName,
    check: () => boolean,
    onUnavailable: (listener: () => void) => () => void,
  ): () => void {
    if (this.gates.has(name)) throw new Error('Realtime admission gate already registered.');
    this.gates.set(name, check);
    const unsubscribe = onUnavailable(() => {
      this.notifyUnavailable();
    });
    return () => {
      unsubscribe();
      this.gates.delete(name);
      this.notifyUnavailable();
    };
  }

  /** Registers a transport to close immediately on a delivery gate outage. */
  public onUnavailable(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Lets each local Socket.IO server close its current connections. */
  private notifyUnavailable(): void {
    for (const listener of this.listeners) listener();
  }
  // #endregion
}
