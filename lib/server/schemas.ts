/** zod input schemas for every mutating route (mirrors lib/api-types.ts requests). */
import "./guard";
import { z } from "zod";
import { checkRecipientWallet, checkWallet, isValidEmail, PAYMENT_CATEGORIES, PAYMENT_FREQUENCIES, UNSUPPORTED_CHARS } from "../csv/validate";
import { MoneyParseError, parseMusd, UINT128_MAX } from "../money";

/** Same character policy as the CSV validator: no C0/C1 controls, bidi overrides/isolates, zero-width chars or BOM. */
export const zText = (max: number) => z.string().trim().max(max).refine((v) => !UNSUPPORTED_CHARS.test(v), "contains unsupported characters");
export const zHex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte hex hash").transform((s) => s.toLowerCase() as `0x${string}`);
export const zTxHash = zHex32;

/** Any 0x address (checksum enforced for mixed case); output lowercase. Rejects the zero address. */
export const zWallet = z.string().transform((s, ctx) => {
  const r = checkWallet(s);
  if (!r.ok) {
    ctx.addIssue({ code: "custom", message: r.message });
    return z.NEVER;
  }
  return r.address.toLowerCase() as `0x${string}`;
});

/** A payment recipient: zWallet, minus PayFlow's own contracts (MUSD token, escrow, registry). */
export const zRecipientWallet = z.string().transform((s, ctx) => {
  const r = checkRecipientWallet(s);
  if (!r.ok) {
    ctx.addIssue({ code: "custom", message: r.message });
    return z.NEVER;
  }
  return r.address.toLowerCase() as `0x${string}`;
});

export const zEmail = z.string().trim().max(254).refine((s) => isValidEmail(s), "invalid email").transform((s) => s.toLowerCase());
export const zOptEmail = z.union([zEmail, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));

/** Human MUSD → wei string; > 0, ≤ 18 decimals, ≤ uint128. */
export const zAmount = z.string().trim().transform((s, ctx) => {
  try {
    const wei = parseMusd(s);
    if (wei <= 0n) {
      ctx.addIssue({ code: "custom", message: "amount must be greater than zero" });
      return z.NEVER;
    }
    if (wei > UINT128_MAX) {
      ctx.addIssue({ code: "custom", message: "amount is too large" });
      return z.NEVER;
    }
    return wei.toString();
  } catch (e) {
    ctx.addIssue({ code: "custom", message: e instanceof MoneyParseError ? e.message : "invalid amount" });
    return z.NEVER;
  }
});

export const zCategory = z.enum(PAYMENT_CATEGORIES as unknown as [string, ...string[]]);
export const zFrequency = z.enum(PAYMENT_FREQUENCIES as unknown as [string, ...string[]]);
export const zLogoUrl = z.union([z.string().trim().max(500).url().refine((u) => /^https:\/\//i.test(u), "logo URL must be https"), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));
export const zClaimWindowDays = z.number().int().min(1).max(365);

export const createOrgSchema = z.object({
  name: zText(80).min(2),
  description: zText(500).optional().default(""),
  logoUrl: zLogoUrl,
  treasuryWallet: z.union([zWallet, z.null()]).optional().transform((v) => v ?? null),
  defaultClaimWindowDays: zClaimWindowDays.optional().default(30),
  /** Optional creator contact email, copied onto the owner's member row (not part of CreateOrgRequest's required shape). */
  email: zOptEmail,
});
export const updateOrgSchema = z.object({
  name: zText(80).min(2).optional(),
  description: zText(500).optional(),
  logoUrl: zLogoUrl,
  treasuryWallet: z.union([zWallet, z.null()]).optional(),
  defaultClaimWindowDays: zClaimWindowDays.optional(),
});
export const confirmTxSchema = z.object({ txHash: zTxHash });

export const upsertMemberSchema = z.object({
  walletAddress: zWallet,
  roles: z.number().int().min(0).max(7),
  email: zOptEmail,
  displayName: z.union([zText(80), z.null()]).optional().transform((v) => (v ? v : null)),
  txHash: zTxHash,
});

export const recipientInputSchema = z.object({
  name: zText(200).min(1),
  email: zOptEmail,
  walletAddress: zRecipientWallet,
  externalId: z.union([zText(100), z.null()]).optional().transform((v) => (v ? v : null)),
  department: z.union([zText(100), z.null()]).optional().transform((v) => (v ? v : null)),
  paymentCategory: z.union([zCategory, z.null()]).optional().transform((v) => v ?? null),
  paymentFrequency: z.union([zFrequency, z.null()]).optional().transform((v) => v ?? null),
  defaultAmount: z.union([zAmount, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null)),
  status: z.enum(["active", "inactive"]).optional(),
});
export const recipientPatchSchema = z.object({
  name: zText(200).min(1).optional(),
  email: zOptEmail,
  walletAddress: zRecipientWallet.optional(),
  externalId: z.union([zText(100), z.null()]).optional(),
  department: z.union([zText(100), z.null()]).optional(),
  paymentCategory: z.union([zCategory, z.null()]).optional(),
  paymentFrequency: z.union([zFrequency, z.null()]).optional(),
  defaultAmount: z.union([zAmount, z.literal(""), z.null()]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});
export const recipientQuerySchema = z.object({
  q: z.string().max(100).optional(),
  department: z.string().max(100).optional(),
  status: z.enum(["active", "inactive", "all"]).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const csvBodySchema = z.object({ csv: z.string().max(1024 * 1024 * 2) });
export const validateCsvSchema = z.object({
  csv: z.string().max(1024 * 1024 * 2),
  employerBalanceWei: z.string().regex(/^\d{1,78}$/).optional(),
  maxAmountPerRow: z.string().regex(/^\d+(\.\d{1,18})?$/).optional(),
  kind: z.enum(["payroll", "recipients"]).optional(),
});

export const runItemSchema = z.object({
  recipientId: z.union([z.string().uuid(), z.null()]).optional().transform((v) => v ?? null),
  name: zText(200).min(1),
  email: zOptEmail,
  department: z.union([zText(100), z.null()]).optional().transform((v) => (v ? v : null)),
  walletAddress: zRecipientWallet,
  amount: zAmount,
  description: zText(500).optional().default(""),
});
const runBase = {
  name: zText(120).min(1),
  paymentCategory: zCategory,
  frequency: z.enum(["one_time", "monthly"]),
  scheduledAt: z.union([z.string().datetime({ offset: true }), z.null()]).optional().transform((v) => v ?? null),
  claimWindowDays: zClaimWindowDays.optional(),
  items: z.array(runItemSchema).min(1).max(5000),
};
export const createRunSchema = z.object(runBase);
export const updateRunSchema = z.object({
  name: runBase.name.optional(),
  paymentCategory: runBase.paymentCategory.optional(),
  frequency: runBase.frequency.optional(),
  scheduledAt: runBase.scheduledAt,
  claimWindowDays: runBase.claimWindowDays,
  items: runBase.items.optional(),
});
export const runTxSchema = z.object({
  action: z.enum(["create", "allocate", "submit", "approve", "return", "fund", "publish", "cancel", "cancel_payment", "expire", "refund"]),
  txHash: zTxHash,
  rejectionReason: zText(500).optional(),
});

export const scheduleInputSchema = z.object({
  name: zText(120).min(1),
  paymentCategory: zCategory,
  frequency: z.enum(["weekly", "biweekly", "monthly"]),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  items: z.array(z.object({ recipientId: z.string().uuid(), amount: zAmount, description: zText(500).optional().default("") })).min(1).max(5000),
  active: z.boolean().optional(),
});

export const notificationsReadSchema = z.object({
  ids: z.array(z.string().uuid()).max(500).optional(),
  all: z.boolean().optional(),
});
