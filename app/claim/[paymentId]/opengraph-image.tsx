import { ImageResponse } from "next/og";
import { formatMusd } from "@/lib/money";
import { OG_SIZE, OgCard } from "@/components/brand/og-card";
import { loadClaimForMeta } from "@/lib/client/claim-meta";

export const alt = "A PayFlow payment";
export const size = OG_SIZE;
export const contentType = "image/png";
export const runtime = "nodejs";

export default async function Image({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  const c = await loadClaimForMeta(paymentId);
  return new ImageResponse(
    c ? (
      <OgCard subtitle={`${c.organization.name} sent you`} title={`${formatMusd(c.amount)} MUSD`} footer="Open the link to claim it with your wallet." />
    ) : (
      <OgCard title="You have a payment on PayFlow" footer="Open the link to claim it with your wallet." />
    ),
    size,
  );
}
