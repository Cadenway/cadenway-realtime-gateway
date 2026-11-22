import { RedeemRealtimeTicketInternalResponse } from '@cadenway/contracts/validators/internal/identity-service';

/** Validates the Identity source membership carried in verified socket metadata. */
export const samlSourceMembershipSchema =
  RedeemRealtimeTicketInternalResponse.shape.samlSourceMembership.unwrap().strict();
