import { z } from 'zod';
import {
  PickupAddressSchema,
  PickupCoordinatesSchema,
  PickupHoursSchema,
} from './checkout.dto';

/**
 * T2 H1: `GET /chatbot-api/branch` (scope `catalog:read`, docs/contracts/
 * branch-location.md). The same source and part shapes as the checkout
 * `pickupLocation`: the branch name, its address and opening hours (null
 * until staff set them) and the store pin (null until staff set the
 * coordinates). Exactly these four keys: anything else is contract drift.
 */
export const BranchInfoSchema = z
  .object({
    name: z.string().min(1),
    address: PickupAddressSchema.nullable(),
    hours: PickupHoursSchema.nullable(),
    location: PickupCoordinatesSchema.nullable(),
  })
  .strict();

export type BranchInfo = z.infer<typeof BranchInfoSchema>;

/** The parsed branch, or `null` when the body breaks the contract. */
export function parseBranchInfo(body: unknown): BranchInfo | null {
  const parsed = BranchInfoSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
