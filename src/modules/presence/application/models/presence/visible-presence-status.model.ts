import type { PresenceStatus } from './presence-status.model.js';

/** A status other members can see. Invisible and offline members are absent from a snapshot. */
export type VisiblePresenceStatus = Exclude<PresenceStatus, 'invisible'>;
