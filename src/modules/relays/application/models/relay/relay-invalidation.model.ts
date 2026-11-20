/** The minimal event data required to invalidate sockets and authorization proofs. */
export type RelayInvalidation =
  | {
      readonly kind: 'session-revoked' | 'session-switched';
      readonly sessionId: string;
      readonly version: number;
    }
  | {
      readonly kind: 'member-removed';
      readonly organizationId: string;
      readonly memberId: string;
      readonly version: number;
    }
  | {
      readonly kind: 'member-role';
      readonly organizationId: string;
      readonly memberId: string;
      readonly version: number;
      readonly role: 'owner' | 'admin' | 'member' | 'guest';
    }
  | { readonly kind: 'organization'; readonly organizationId: string; readonly factId: string }
  | { readonly kind: 'visibility'; readonly organizationId: string };
