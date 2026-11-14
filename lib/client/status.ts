import type { ItemClaimStatus, RunStatus } from "@/lib/api-types";
import { plural } from "./format";

export type Tone = "idle" | "info" | "warn" | "ok" | "bad" | "brand";

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "idle" },
  onchain_draft: { label: "Building on-chain", tone: "idle" },
  pending_approval: { label: "Awaiting approval", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  funded: { label: "Funded", tone: "info" },
  published: { label: "Open for claims", tone: "ok" },
  partially_claimed: { label: "Partly claimed", tone: "ok" },
  completed: { label: "Completed", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "bad" },
  expired: { label: "Expired", tone: "idle" },
};

/** Raw claim status words. Prefer itemStatus(), which also looks at the run's state. */
export const ITEM_STATUS: Record<ItemClaimStatus, { label: string; tone: Tone }> = {
  pending: { label: "Not on-chain yet", tone: "idle" },
  allocated: { label: "Unclaimed", tone: "warn" },
  claimed: { label: "Claimed", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "bad" },
  expired: { label: "Expired", tone: "idle" },
};

export const CLAIM_STATUS: Record<"allocated" | "claimed" | "cancelled" | "not_published" | "expired", { label: string; tone: Tone }> = {
  allocated: { label: "Ready to claim", tone: "ok" },
  claimed: { label: "Claimed", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "bad" },
  not_published: { label: "Not available yet", tone: "idle" },
  expired: { label: "Expired", tone: "idle" },
};

export const RECIPIENT_PAYMENT_STATUS: Record<"available" | "claimed" | "cancelled" | "expired" | "upcoming", { label: string; tone: Tone }> = {
  available: { label: "Ready to claim", tone: "warn" },
  claimed: { label: "Claimed", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "bad" },
  expired: { label: "Expired", tone: "idle" },
  upcoming: { label: "Upcoming", tone: "info" },
};

/** Order of the main path, used for the run timeline. */
export const RUN_PATH: { key: string; label: string; reached: RunStatus[] }[] = [
  { key: "draft", label: "Draft saved", reached: ["draft", "onchain_draft", "pending_approval", "approved", "funded", "published", "partially_claimed", "completed", "expired"] },
  { key: "onchain", label: "Added on-chain", reached: ["pending_approval", "approved", "funded", "published", "partially_claimed", "completed", "expired"] },
  { key: "approved", label: "Approved", reached: ["approved", "funded", "published", "partially_claimed", "completed", "expired"] },
  { key: "funded", label: "Funded", reached: ["funded", "published", "partially_claimed", "completed", "expired"] },
  { key: "published", label: "Open for claims", reached: ["published", "partially_claimed", "completed", "expired"] },
  { key: "done", label: "All claimed", reached: ["completed"] },
];

const BEFORE_FUNDING: RunStatus[] = ["draft", "onchain_draft", "pending_approval", "approved"];
const OPEN: RunStatus[] = ["published", "partially_claimed", "completed"];

/**
 * What one payment's status means to a person, given the run it belongs to. A payment is only
 * "Unclaimed" once its run is open for claims; before that it is waiting for funding or publishing.
 * The same words are used in the table, the filters and the copied claim-link list.
 */
export function itemStatus(claim: ItemClaimStatus, run: RunStatus): { label: string; tone: Tone } {
  if (claim === "claimed") return ITEM_STATUS.claimed;
  if (claim === "cancelled" || run === "cancelled") return ITEM_STATUS.cancelled;
  if (claim === "expired" || run === "expired") return ITEM_STATUS.expired;
  if (claim === "pending") return ITEM_STATUS.pending;
  // allocated
  if (BEFORE_FUNDING.includes(run)) return { label: "Waiting for funding", tone: "idle" };
  if (run === "funded") return { label: "Not published yet", tone: "info" };
  if (OPEN.includes(run)) return { label: "Unclaimed", tone: "warn" };
  return ITEM_STATUS.allocated;
}

export type StepState = "done" | "current" | "todo";

/**
 * Run timeline. The step the run is in now is "current" (and only that one); later steps are "todo".
 * A partly claimed run is current at "Open for claims", not at "All claimed".
 */
export function timelineSteps(status: RunStatus): { key: string; label: string; state: StepState }[] {
  const reached = RUN_PATH.reduce((acc, s, i) => (s.reached.includes(status) ? i : acc), -1);
  // Finished runs have no current step: everything reached is done.
  const finished = status === "completed" || status === "cancelled" || status === "expired";
  return RUN_PATH.map((s, i) => ({
    key: s.key,
    label: s.label,
    state: i < reached || (i === reached && finished) ? "done" : i === reached ? "current" : "todo",
  }));
}

/** "1 claim", "2 claims". */
export const claimsLabel = (n: number) => plural(n, "claim");
