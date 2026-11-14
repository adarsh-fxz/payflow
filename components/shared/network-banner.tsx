"use client";

import { isDeployed } from "@/lib/chain/config";
import { useMounted } from "@/hooks/use-mounted";
import { useWallet } from "@/hooks/use-wallet";
import { describeTxError } from "@/lib/client/errors";
import { toast } from "sonner";

/** Contracts-not-deployed and wrong-network notices. Off-chain features keep working. */
export function NetworkBanner() {
  const mounted = useMounted();
  const w = useWallet();
  if (!isDeployed) {
    return (
      <div role="status" className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-center text-[0.8125rem]">
        PayFlow contracts are not deployed on this environment yet. You can set things up, but on-chain actions are turned off.
      </div>
    );
  }
  if (mounted && w.network.kind === "wrong-network") {
    return (
      <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warn/40 bg-warn/10 px-4 py-2 text-[0.8125rem]">
        <span>Your wallet is on another network. PayFlow runs on Mezo Testnet.</span>
        <button
          type="button"
          disabled={w.isSwitching}
          onClick={() => w.switchToMezo().catch((e) => toast.error(describeTxError(e).title, { description: describeTxError(e).message }))}
          className="cursor-pointer font-medium underline underline-offset-4 disabled:opacity-60"
        >
          {w.isSwitching ? "Switching…" : "Switch network"}
        </button>
      </div>
    );
  }
  return null;
}
