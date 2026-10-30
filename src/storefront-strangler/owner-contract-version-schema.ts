/* eslint-disable prettier/prettier -- Independent, strict QA owner validation before irreversible rights denial. */
import {z} from "zod/v3";
export const ownerContractVersionSchema = z.object({
  contractId: z.string().min(1),
  versionNumber: z.number().int().min(1),
  status: z.enum(["draft", "active", "superseded", "terminated"]).default("draft"),
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime().nullable().optional(),
  retailerCommissionBps: z.number().int().min(0).max(10000),
  paymentSchedule: z
    .object({
      cadence: z.enum(["monthly", "quarterly"]),
      netDays: z.number().int().min(0).max(180),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
      minimumPayoutMinor: z.number().int().min(0).optional(),
    })
    .passthrough(),
  returnsPolicy: z.record(z.string(), z.unknown()).default({}),
  subscriptionTerms: z.record(z.string(), z.unknown()).default({ permitted: false }),
  marketingPermissions: z.record(z.string(), z.unknown()).default({}),
  drmRequirements: z.record(z.string(), z.unknown()).default({}),
  deliveryRules: z.record(z.string(), z.unknown()).default({}),
  terminationPolicy: z.record(z.string(), z.unknown()).default({}),
  postTerminationAccessPolicy: z
    .enum([
      "preserve_perpetual_purchases",
      "preserve_downloaded_only",
      "block_future_downloads",
      "revoke_all",
    ])
    .default("preserve_perpetual_purchases"),
  documentSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .or(z.literal(""))
    .default(""),
  sourceDocumentObjectKey: z.string().max(500).nullable().optional(),
  territories: z
    .array(
      z.object({
        territoryCode: z.string().regex(/^[A-Z]{2}$/),
        decision: z.enum(["allow", "deny"]).default("allow"),
      }),
    )
    .min(1)
    .max(300),
  formats: z
    .array(
      z.object({
        format: z.string().min(1).max(40),
        decision: z.enum(["allow", "deny"]).default("allow"),
        drmRequirement: z.string().max(80).default("none"),
        downloadLimit: z.number().int().min(0).nullable().optional(),
        deviceLimit: z.number().int().min(0).nullable().optional(),
        offlinePermitted: z.boolean().default(true),
      }),
    )
    .min(1)
    .max(20),
  channels: z
    .array(
      z.object({
        salesChannel: z.enum(["retail", "subscription", "library"]),
        permitted: z.boolean(),
        terms: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(3),
});
