import { z } from 'zod';

/** Validates the opt-in source binding until the Identity contract release exports the field. */
export const samlSourceMembershipSchema = z.strictObject({
  organizationId: z.uuid(),
  memberId: z.uuid(),
});
