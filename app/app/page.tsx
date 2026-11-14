import type { Metadata } from "next";
import { SiteHeader } from "@/components/site/site-header";
import { AuthGate } from "@/components/wallet/auth-gate";
import { OrgPicker } from "@/components/org/org-picker";

export const metadata: Metadata = { title: "Organizations", robots: { index: false } };

export default function AppHome() {
  return (
    <>
      <SiteHeader minimal />
      <main id="main" className="flex-1">
        <AuthGate title="Sign in to manage payroll" body="Your wallet is your login. Signing is free and does not send a transaction.">
          <OrgPicker />
        </AuthGate>
      </main>
    </>
  );
}
