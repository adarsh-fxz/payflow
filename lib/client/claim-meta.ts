import "server-only";
import type { ClaimInfo } from "@/lib/api-types";

/** Server-only lookup for claim metadata/OG. Shows only org name + amount; never the recipient. */
export async function loadClaimForMeta(paymentId: string): Promise<Pick<ClaimInfo, "organization" | "amount"> | null> {
  if (!/^\d{1,78}$/.test(paymentId)) return null;
  try {
    const [{ getDb }, { getClaimInfo }] = await Promise.all([import("@/lib/server/db"), import("@/lib/server/claims")]);
    const info = await getClaimInfo(getDb(), paymentId, null);
    return { organization: info.organization, amount: info.amount };
  } catch {
    return null;
  }
}
