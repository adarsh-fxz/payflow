import Link from "next/link";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/site/site-header";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

export default function NotFound() {
  return (
    <>
      <SiteHeader minimal />
      <main id="main" className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-4 py-20">
        <p className="num text-sm text-muted-foreground">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em]">This page doesn&apos;t exist</h1>
        <p className="mt-2 text-muted-foreground">The link may be old or mistyped. If you were sent a payment, open the claim link from your email again.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/">Go to PayFlow</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/payments">My payments</Link>
          </Button>
        </div>
      </main>
    </>
  );
}
