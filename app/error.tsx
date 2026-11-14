"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main id="main" className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-4 py-20">
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">Something went wrong</h1>
      <p className="mt-2 text-muted-foreground">This page hit an unexpected error. Nothing was sent from your wallet. Try again, and if it keeps happening, reload the page.</p>
      {error.digest ? <p className="mt-2 font-mono text-xs text-muted-foreground">Reference {error.digest}</p> : null}
      <div className="mt-8 flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/">Home</Link>
        </Button>
      </div>
    </main>
  );
}
