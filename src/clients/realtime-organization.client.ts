import type { RealtimeSession } from '@cadenway/contracts/types/internal/identity-service';
import { GetSearchMembershipInternalResponse } from '@cadenway/contracts/validators/internal/organization-service';
import type { InternalHttpClient, InternalRequestInit } from '@cadenway/nest-common';

import { bindInternalFetch, readInternalJson } from '../infrastructure/http/internal-json.js';
import { getOrganizationServiceInternalRoutes } from './generated/organization-service.js';

/** Reads Organization's current proof for the socket's signed account and tenant. */
export class RealtimeOrganizationClient {
  // #region Properties
  /** Organization routes bound to the signed HTTP client. */
  private readonly routes: ReturnType<typeof getOrganizationServiceInternalRoutes>;
  // #endregion

  // #region Constructor
  /** Binds the upstream client without exposing any credential. */
  public constructor(http: InternalHttpClient) {
    this.routes = getOrganizationServiceInternalRoutes(bindInternalFetch(http));
  }
  // #endregion

  // #region Methods
  /** Requires the socket's current membership and the SAML source membership, when present. */
  public async matches(
    session: Pick<
      RealtimeSession,
      'userId' | 'organizationId' | 'memberId' | 'role' | 'samlSourceMembership'
    >,
  ): Promise<boolean> {
    const current = await this.read(session.userId, session.organizationId);
    if (current?.memberId !== session.memberId || current.role !== session.role) {
      return false;
    }
    const source = session.samlSourceMembership;
    if (source === undefined) return true;
    if (source.organizationId === session.organizationId)
      return current.memberId === source.memberId;
    const membership = await this.read(session.userId, source.organizationId);
    return membership !== null && membership.memberId === source.memberId;
  }

  private async read(userId: string, organizationId: string) {
    const options: InternalRequestInit = {
      claims: { organizationId, actor: { type: 'user', id: userId }, scopes: [] },
      idempotent: false,
    };
    const response = await readInternalJson(
      this.routes.getSearchMembershipInternal(options),
      'Realtime membership verification is unavailable.',
    );
    if (response === null) return null;
    const membership = GetSearchMembershipInternalResponse.strict().parse(response.data);
    return { memberId: membership.memberId.toLowerCase(), role: membership.role };
  }
  // #endregion
}
