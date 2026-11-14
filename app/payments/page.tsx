import type { Metadata } from "next";
import { SiteHeader } from "@/components/site/site-header";
import { AuthGate } from "@/components/wallet/auth-gate";
import { PaymentsView } from "@/components/payments/payments-view";

export const metadata: Metadata = { title: "My payments", description: "Every PayFlow payment sent to your wallet, across organizations.", robots: { index: false } };

export default function PaymentsPage() {
  return (
    <>
      <SiteHeader minimal />
      <main id="main" className="flex-1">
        <AuthGate title="See your payments" body="Sign in with the wallet you get paid to. Signing is free and does not send a transaction.">
          <PaymentsView />
        </AuthGate>
      </main>
    </>
  );
}
