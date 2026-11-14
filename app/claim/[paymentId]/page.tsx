import type { Metadata } from "next";
import { formatMusd } from "@/lib/money";
import { loadClaimForMeta } from "@/lib/client/claim-meta";
import { SiteHeader } from "@/components/site/site-header";
import { ClaimView } from "@/components/claim/claim-view";

type Props = { params: Promise<{ paymentId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { paymentId } = await params;
  const c = await loadClaimForMeta(paymentId);
  const title = c ? `${formatMusd(c.amount)} MUSD from ${c.organization.name}` : "Claim your payment";
  const description = c ? `${c.organization.name} sent you ${formatMusd(c.amount)} MUSD on PayFlow. Connect your wallet to claim it.` : "Connect your wallet to claim a PayFlow payment.";
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function ClaimPage({ params }: Props) {
  const { paymentId } = await params;
  return (
    <>
      <SiteHeader minimal />
      <main id="main" className="flex flex-1 items-start justify-center bg-surface px-4 py-10 sm:py-16">
        <div className="w-full max-w-md">
          <ClaimView paymentId={paymentId} />
        </div>
      </main>
    </>
  );
}
