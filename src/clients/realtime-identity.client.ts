import {
  RedeemRealtimeTicketInternalBody,
  RedeemRealtimeTicketInternalResponse,
} from '@cadenway/contracts/validators/internal/identity-service';
import {
  MAX_CALL_TIMEOUT_MS,
  type InternalHttpClient,
  type InternalRequestInit,
} from '@cadenway/nest-common';

import { bindInternalFetch, readInternalJson } from '../infrastructure/http/internal-json.js';
import { getIdentityServiceInternalRoutes } from './generated/identity-service.js';

const unavailable = 'Identity ticket redemption is unavailable.';
const realtimeSession = RedeemRealtimeTicketInternalResponse.strict();

/** The verified Identity session and its effective lease in epoch milliseconds. */
export interface RedeemedRealtimeSession {
  // #region Properties
  /** Stable session identity and its authorization version. */
  readonly sessionId: string;
  readonly sessionVersion: number;

  /** Current account, organization and membership from Identity. */
  readonly userId: string;
  readonly organizationId: string;
  readonly memberId: string;
  readonly role: 'owner' | 'admin' | 'member' | 'guest';

  /** The earlier of the absolute and inactivity expiration instants. */
  readonly expiresAt: number;
  // #endregion
}

/** Exchanges a single-use handshake ticket for the current session at Identity. */
export class RealtimeIdentityClient {
  // #region Properties
  /** Generated routes bound to the signed Identity transport. */
  private readonly routes: ReturnType<typeof getIdentityServiceInternalRoutes>;
  // #endregion

  // #region Constructor
  /** Receives the internal HTTP client scoped to Identity. */
  public constructor(http: InternalHttpClient) {
    this.routes = getIdentityServiceInternalRoutes(bindInternalFetch(http));
  }
  // #endregion

  // #region Methods
  /** Consumes the ticket once, with a system actor outside any organization. */
  public async redeem(token: string): Promise<RedeemedRealtimeSession | null> {
    const body = RedeemRealtimeTicketInternalBody.safeParse({ token });
    if (!body.success) return null;

    const options: InternalRequestInit = {
      claims: { organizationId: null, actor: { type: 'system', id: null } },
      idempotent: false,
      streamTimeoutMs: MAX_CALL_TIMEOUT_MS,
    };
    const response = await readInternalJson(
      this.routes.redeemRealtimeTicketInternal(body.data, options),
      unavailable,
    );
    if (response === null) return null;

    const session = realtimeSession.safeParse(response.data);
    if (
      !session.success ||
      response.headers.get('cache-control')?.trim().toLowerCase() !== 'no-store'
    ) {
      throw new Error(unavailable);
    }
    const { sessionId, sessionVersion, userId, organizationId, memberId, role, sessionExpiresAt } =
      session.data;
    const expiresAt = Date.parse(sessionExpiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null;
    return {
      sessionId: sessionId.toLowerCase(),
      sessionVersion,
      userId: userId.toLowerCase(),
      organizationId: organizationId.toLowerCase(),
      memberId: memberId.toLowerCase(),
      role,
      expiresAt,
    };
  }
  // #endregion
}
