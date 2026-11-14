"use client";

import { useEffect, useRef, useState } from "react";
import { useReadContract } from "wagmi";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CircleCheck } from "lucide-react";
import type { ClaimInfo } from "@/lib/api-types";
import { payrollEscrowAbi } from "@/lib/chain/abis";
import { contracts, isDeployed, MEZO_TESTNET_ID } from "@/lib/chain/config";
import { formatMusd } from "@/lib/money";
import { ApiClientError, errorMessage, isChainUnavailable, OUTAGE_POLL_MS, postUntilMined } from "@/lib/client/api";
import { canCloseRunFromClaim, saveInBackground } from "@/lib/client/claim-flow";
import { describeTxError } from "@/lib/client/errors";
import { formatDate, shortAddress } from "@/lib/client/format";
import { CLAIM_STATUS } from "@/lib/client/status";
import { checksum } from "@/lib/client/run-gates";
import { build } from "@/lib/client/writes";
import { useClaim } from "@/hooks/use-api";
import { useMounted } from "@/hooks/use-mounted";
import { useNow } from "@/hooks/use-now";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/shared/status-dot";
import { TxLink } from "@/components/shared/address";
import { TxStatus } from "@/components/shared/tx-status";
import { ConnectDialog } from "@/components/wallet/connect-dialog";
import { OrgAvatar } from "@/components/org/org-picker";
import { ChainBanner, DataAge } from "@/components/shared/chain-banner";

export function ClaimView({ paymentId }: { paymentId: string }) {
  const q = useClaim(paymentId);
  const mounted = useMounted();
  const reduce = useReducedMotion();

  if (q.isLoading) {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <Skeleton className="size-12 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <Skeleton className="mt-8 h-10 w-48" />
        <Skeleton className="mt-8 h-11 w-full" />
      </Card>
    );
  }
  if (!q.data && isChainUnavailable(q.error)) {
    return (
      <Card>
        <h1 className="text-lg font-semibold">Can&apos;t reach Mezo right now</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your payment is safe in the escrow. PayFlow needs the Mezo network to show its status and let you claim, and it isn&apos;t answering. This page checks again on its own every {OUTAGE_POLL_MS / 1000} seconds.
        </p>
        {mounted && q.errorUpdatedAt ? <DataAge at={q.errorUpdatedAt} prefix="Last tried" className="mt-2 block text-xs text-muted-foreground" /> : null}
        <Button variant="outline" className="mt-6" disabled={q.isFetching} onClick={() => void q.refetch()}>
          {q.isFetching ? "Checking…" : "Check again"}
        </Button>
      </Card>
    );
  }
  if (!q.data) {
    const notFound = q.error instanceof ApiClientError && (q.error.code === "not_found" || q.error.code === "invalid_input");
    return (
      <Card>
        <h1 className="text-lg font-semibold">{notFound ? "Payment not found" : "Couldn't load this payment"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {notFound ? "Check that you copied the whole link from your email. If it still doesn't work, ask the sender for a new link." : errorMessage(q.error)}
        </p>
        {!notFound ? (
          <Button variant="outline" className="mt-6" onClick={() => void q.refetch()}>
            Try again
          </Button>
        ) : null}
      </Card>
    );
  }

  const c = q.data;
  // A refetch failed but we still hold the last answer: show it, clearly marked as possibly stale.
  const stale = isChainUnavailable(q.error);
  return (
    <motion.div initial={reduce ? false : { y: 8 }} animate={{ y: 0 }} transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}>
      {stale ? <ChainBanner hasData updatedAt={q.dataUpdatedAt} className="mb-4" /> : null}
      <Card>
        <div className="flex items-center gap-3">
          <OrgAvatar name={c.organization.name} logoUrl={c.organization.logoUrl} size="lg" />
          <div className="min-w-0">
            <p className="truncate font-semibold">{c.organization.name}</p>
            <p className="truncate text-sm text-muted-foreground">{c.runName}</p>
          </div>
        </div>

        <div className="mt-8">
          <p className="text-sm text-muted-foreground">Amount</p>
          <p className="num mt-1 text-4xl font-semibold tracking-[-0.02em]">
            {formatMusd(c.amount)} <span className="text-xl font-medium text-muted-foreground">MUSD</span>
          </p>
        </div>

        <dl className="mt-6 divide-y border-y text-sm">
          {c.description ? (
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Reference</dt>
              <dd className="text-right">{c.description}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <StatusDot tone={CLAIM_STATUS[c.status].tone} label={CLAIM_STATUS[c.status].label} />
            </dd>
          </div>
          <div className="flex justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">Paid to</dt>
            <dd className="font-mono text-[0.8125rem]">{shortAddress(checksum(c.recipientAddress), 6)}</dd>
          </div>
          {c.claimDeadline && c.status === "allocated" ? (
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted-foreground">Claim by</dt>
              <dd>{formatDate(c.claimDeadline, true)}</dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-6">{mounted ? <ClaimAction claim={c} onDone={() => void q.refetch()} /> : <Skeleton className="h-11 w-full" />}</div>
        {mounted && q.dataUpdatedAt ? <DataAge at={q.dataUpdatedAt} prefix="Status checked" className="mt-3 block text-center text-xs text-muted-foreground" /> : null}
      </Card>
      <p className="mt-4 text-center text-[0.8125rem] text-muted-foreground">
        Paid through PayFlow on Mezo Testnet.{" "}
        <Link href="/payments" className="underline-offset-4 hover:text-foreground hover:underline">
          See all your payments
        </Link>
      </p>
    </motion.div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border bg-card p-6 shadow-[0_1px_2px_oklch(0.2_0.01_60/0.04),0_12px_40px_-24px_oklch(0.2_0.01_60/0.25)] sm:p-8">{children}</div>;
}

function ClaimAction({ claim, onDone }: { claim: ClaimInfo; onDone: () => void }) {
  const w = useWallet();
  const tx = useTx();
  const reduce = useReducedMotion();
  const [connectOpen, setConnectOpen] = useState(false);
  const [wantClaim, setWantClaim] = useState(false);
  const [done, setDone] = useState<{ hash: string } | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const started = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const isRecipient = Boolean(w.address && w.address.toLowerCase() === claim.recipientAddress.toLowerCase());

  async function claimNow() {
    if (started.current) return;
    started.current = true;
    let hash = "";
    const save = () => postUntilMined<ClaimInfo>(`/api/claims/${claim.paymentId}/confirm`, { txHash: hash });
    const res = await tx.run(build.claim(BigInt(claim.paymentId)), {
      // The claim is final once mined. Saving it to PayFlow is bookkeeping (the worker indexes it
      // too), so a failed save is retried quietly in the background and never shown as an error.
      record: async (h) => {
        hash = h;
        try {
          await save();
        } catch {
          void saveInBackground(save, { cancelled: () => !alive.current }).then((ok) => {
            if (ok && alive.current) onDone();
          });
        }
      },
      successMessage: "Payment claimed",
    });
    started.current = false;
    if (res) {
      setDone({ hash: res.hash });
      onDone();
    }
  }

  // After the user connects (and switches network) from the one button, continue to the claim.
  useEffect(() => {
    if (!wantClaim || !w.isConnected) return;
    if (w.network.kind === "wrong-network") {
      w.switchToMezo().catch((e) => {
        setSwitchError(describeTxError(e).message);
        setWantClaim(false);
      });
      return;
    }
    if (w.isReady) {
      // defer: state updates belong to the async follow-up, not the effect body
      void Promise.resolve().then(() => {
        setWantClaim(false);
        if (isRecipient) void claimNow();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantClaim, w.isConnected, w.isReady, w.network.kind, isRecipient]);

  if (done || claim.status === "claimed") {
    const hash = done?.hash ?? claim.transactionHash;
    return (
      <AnimatePresence>
        <motion.div initial={reduce ? false : { opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.25 }} className="rounded-lg border border-ok/40 bg-ok/[0.06] p-4">
          <p className="flex items-center gap-2 font-medium">
            <CircleCheck className="size-5 text-ok" />
            {done ? `${formatMusd(claim.amount)} MUSD received` : "Already claimed"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {done ? "The MUSD is in your wallet now." : claim.claimedAt ? `Claimed on ${formatDate(claim.claimedAt, true)}.` : "This payment was claimed."}
          </p>
          {hash ? <TxLink hash={hash} label={`View transaction ${hash.slice(0, 10)}…`} className="mt-2" /> : null}
        </motion.div>
      </AnimatePresence>
    );
  }
  if (claim.status === "cancelled") return <Notice title="This payment was cancelled">The sender cancelled it before it was published. Contact {claim.organization.name} if you think this is a mistake.</Notice>;
  if (claim.status === "expired") return <ClosedWindow claim={claim} onClosed={onDone} />;
  if (claim.status === "not_published") return <Notice title="Not ready yet">{claim.organization.name} hasn&apos;t opened this payment for claims yet. You&apos;ll be able to claim it from this page once they do.</Notice>;
  if (!isDeployed) return <Notice title="Claims are turned off">PayFlow contracts aren&apos;t deployed on this environment.</Notice>;

  if (w.isConnected && w.address && !isRecipient) {
    return (
      <Notice title="This wallet can't claim this payment" tone="bad">
        The payment is for <span className="font-mono">{shortAddress(checksum(claim.recipientAddress), 6)}</span>, but you&apos;re connected with <span className="font-mono">{shortAddress(w.address, 6)}</span>. Switch to the right account in your wallet.
      </Notice>
    );
  }

  const busy = tx.isBusy || wantClaim;
  return (
    <div className="space-y-3">
      <Button
        size="lg"
        className="h-12 w-full text-base"
        disabled={busy || w.isSwitching}
        onClick={() => {
          setSwitchError(null);
          tx.reset();
          if (!w.isConnected) {
            setWantClaim(true);
            setConnectOpen(true);
          } else if (!w.isReady) {
            setWantClaim(true);
          } else {
            void claimNow();
          }
        }}
      >
        {tx.state.phase === "signing"
          ? "Confirm in your wallet…"
          : tx.state.phase === "pending" || tx.state.phase === "recording"
            ? "Claiming…"
            : w.isSwitching
              ? "Switching network…"
              : w.isConnected
                ? "Claim payment"
                : "Connect wallet & claim payment"}
      </Button>
      <p className="text-center text-[0.8125rem] text-muted-foreground">You pay a small network fee in testnet BTC.</p>
      {switchError ? <p className="text-sm text-bad">{switchError}</p> : null}
      <TxStatus state={tx.state} />
      <ConnectDialog
        open={connectOpen}
        onOpenChange={(v) => {
          setConnectOpen(v);
          if (!v && !w.isConnected) setWantClaim(false);
        }}
      />
    </div>
  );
}

/**
 * The claim window is over. While the run is still Published on-chain, any connected wallet may
 * close it (expireRun is permissionless after the deadline); that lets the sender refund what was
 * not claimed. The run is not reported to PayFlow from here (that needs the org's run id and a
 * session); the worker indexes RunExpired and this page re-reads the chain.
 */
function ClosedWindow({ claim, onClosed }: { claim: ClaimInfo; onClosed: () => void }) {
  const w = useWallet();
  const tx = useTx();
  const now = useNow();
  const [connectOpen, setConnectOpen] = useState(false);
  const runId = BigInt(claim.chainRunId);
  const chainRun = useReadContract({
    address: contracts.escrow,
    abi: payrollEscrowAbi,
    functionName: "getRun",
    args: [runId],
    chainId: MEZO_TESTNET_ID,
    query: { enabled: isDeployed && runId > 0n, refetchInterval: (q) => (q.state.status === "error" ? OUTAGE_POLL_MS : false) },
  });
  const r = chainRun.data;
  const closable = isDeployed && canCloseRunFromClaim(r ? Number(r.status) : undefined, r?.claimDeadline, now);

  if (!closable) {
    return (
      <Notice title="This claim window has closed">
        This payment wasn&apos;t claimed in time and can be refunded to the sender. Contact {claim.organization.name} to ask about it.
      </Notice>
    );
  }

  async function close() {
    const res = await tx.run(build.expireRun(runId), { successMessage: "Run closed" });
    if (res) {
      await chainRun.refetch();
      onClosed();
    }
  }

  return (
    <div className="space-y-3">
      <Notice title="This claim window has closed">
        This payment wasn&apos;t claimed in time. Anyone can close the run now, so {claim.organization.name} can refund what wasn&apos;t claimed. Contact them to ask about your payment.
      </Notice>
      <Button
        variant="outline"
        className="w-full"
        disabled={tx.isBusy || w.isSwitching}
        onClick={() => {
          tx.reset();
          if (!w.isConnected) setConnectOpen(true);
          else if (!w.isReady) void w.switchToMezo().catch(() => undefined);
          else void close();
        }}
      >
        {tx.state.phase === "signing" ? "Confirm in your wallet…" : tx.state.phase === "pending" ? "Closing…" : w.isConnected ? "Close the run" : "Connect wallet to close the run"}
      </Button>
      <TxStatus state={tx.state} />
      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}

function Notice({ title, children, tone = "default" }: { title: string; children: React.ReactNode; tone?: "default" | "bad" }) {
  return (
    <div role="status" className={tone === "bad" ? "rounded-lg border border-bad/40 bg-bad/[0.05] p-4" : "rounded-lg border bg-surface p-4"}>
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
