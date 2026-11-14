"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { describeTxError } from "@/lib/client/errors";
import { shortAddress } from "@/lib/client/format";
import { useMounted } from "@/hooks/use-mounted";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectDialog } from "./connect-dialog";

/** Renders children only for a signed-in wallet; otherwise walks the user through connect → sign. */
export function AuthGate({ children, title = "Sign in to continue", body }: { children: ReactNode; title?: string; body?: string }) {
  const mounted = useMounted();
  const auth = useAuth();
  const w = auth.wallet;
  const [open, setOpen] = useState(false);

  if (!mounted || auth.sessionLoading) {
    return (
      <div className="mx-auto w-full max-w-md space-y-3 px-4 py-16">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-9 w-40" />
      </div>
    );
  }
  if (auth.signedIn) return <>{children}</>;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-16 sm:py-24">
      <h1 className="text-xl font-semibold tracking-[-0.01em]">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {body ?? "PayFlow uses your wallet as your login. Signing a message is free and does not send a transaction."}
      </p>
      <div className="mt-6 space-y-3">
        {!w.isConnected ? (
          <>
            <Button onClick={() => setOpen(true)}>Connect wallet</Button>
            <ConnectDialog open={open} onOpenChange={setOpen} />
          </>
        ) : w.network.kind === "wrong-network" ? (
          <Button disabled={w.isSwitching} onClick={() => w.switchToMezo().catch((e) => toast.error(describeTxError(e).message))}>
            {w.isSwitching ? "Switching…" : "Switch to Mezo Testnet"}
          </Button>
        ) : (
          <>
            <Button
              disabled={auth.signIn.isPending}
              onClick={() => auth.signIn.mutate(undefined, { onError: (e) => toast.error("Sign-in failed", { description: describeTxError(e).message }) })}
            >
              {auth.signIn.isPending ? "Check your wallet…" : "Sign in"}
            </Button>
            <p className="text-[0.8125rem] text-muted-foreground">
              Connected as <span className="font-mono">{shortAddress(w.address)}</span>
              {auth.mismatch ? ". You were signed in with a different wallet." : "."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
