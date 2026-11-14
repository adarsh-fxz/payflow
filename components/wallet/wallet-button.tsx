"use client";

import { useState } from "react";
import Link from "next/link";
import { useDisconnect } from "wagmi";
import { Copy, ExternalLink, LogOut, Wallet } from "lucide-react";
import { toast } from "sonner";
import { explorerAddress } from "@/lib/chain/config";
import { describeTxError } from "@/lib/client/errors";
import { shortAddress } from "@/lib/client/format";
import { useMounted } from "@/hooks/use-mounted";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConnectDialog } from "./connect-dialog";

export function WalletButton({ className }: { className?: string }) {
  const mounted = useMounted();
  const auth = useAuth();
  const w = auth.wallet;
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);

  if (!mounted) {
    return (
      <Button variant="outline" className={className} disabled>
        Connect wallet
      </Button>
    );
  }
  if (!w.isConnected || !w.address) {
    return (
      <>
        <Button variant="outline" className={className} onClick={() => setOpen(true)}>
          <Wallet data-icon="inline-start" /> Connect wallet
        </Button>
        <ConnectDialog open={open} onOpenChange={setOpen} />
      </>
    );
  }
  if (w.network.kind === "wrong-network") {
    return (
      <Button
        className={className}
        disabled={w.isSwitching}
        onClick={() => w.switchToMezo().catch((e) => toast.error(describeTxError(e).title, { description: describeTxError(e).message }))}
      >
        {w.isSwitching ? "Switching…" : "Switch to Mezo Testnet"}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className={className}>
          <span aria-hidden className={auth.signedIn ? "size-1.5 rounded-full bg-ok" : "size-1.5 rounded-full bg-idle"} />
          <span className="font-mono text-[0.8125rem]">{shortAddress(w.address)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <span className="block font-mono text-xs">{shortAddress(w.address, 8)}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{auth.signedIn ? "Signed in" : "Not signed in"}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!auth.signedIn ? (
          <DropdownMenuItem
            disabled={auth.signIn.isPending}
            onSelect={() =>
              auth.signIn.mutate(undefined, {
                onError: (e) => toast.error("Sign-in failed", { description: describeTxError(e).message }),
              })
            }
          >
            Sign in with this wallet
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem asChild>
          <Link href="/payments">My payments</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/app">My organizations</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void navigator.clipboard?.writeText(w.address!);
            toast.success("Address copied");
          }}
        >
          <Copy /> Copy address
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={explorerAddress(w.address)} target="_blank" rel="noreferrer">
            <ExternalLink /> View on explorer
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            if (auth.signedIn) auth.signOut.mutate();
            disconnect();
          }}
        >
          <LogOut /> Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
