"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBalance, useConfig, usePublicClient, useReadContract, useSignTypedData } from "wagmi";
import { readContract } from "@wagmi/core";
import { formatUnits, parseSignature, type Address, type Hex } from "viem";
import type { Organization, PayrollRunDetail, RunChainPlan } from "@/lib/api-types";
import { erc20Abi } from "@/lib/chain/abis";
import { paymentsHash, type CommitmentOp } from "@/lib/chain/commitment";
import { contracts, isDeployed, MEZO_TESTNET_ID } from "@/lib/chain/config";
import { formatMusd } from "@/lib/money";
import { api, errorMessage } from "@/lib/client/api";
import { approvalCountsMatch, canCancelRun, canContinueBuild, canExpire, checksum, hasChainMismatch, stepBlock } from "@/lib/client/run-gates";
import { describeTxError } from "@/lib/client/errors";
import { permitDeadline, permitTypedData } from "@/lib/client/permit";
import { useNow } from "@/hooks/use-now";
import { canAdmin, canApprove, canOperate, canReturn } from "@/lib/client/roles";
import { formatDate, shortAddress } from "@/lib/client/format";
import { cn } from "@/lib/client/utils";
import { build } from "@/lib/client/writes";
import { useWallet } from "@/hooks/use-wallet";
import { useRunChain } from "@/hooks/use-run-chain";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TxStatus } from "@/components/shared/tx-status";
import { CopyButton } from "@/components/shared/address";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Musd } from "@/components/shared/money";
import { useRunTx } from "./use-run-tx";

type Chain = ReturnType<typeof useRunChain>;

function Panel({ title, children, tone = "default" }: { title: string; children: React.ReactNode; tone?: "default" | "attention" }) {
  return (
    <section className={cn("rounded-lg border p-4 sm:p-5", tone === "attention" ? "border-brand/60 bg-brand-soft/40" : "bg-card")}>
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-2 space-y-3 text-sm">{children}</div>
    </section>
  );
}

function Blocked({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}

/** The single next action for this run, shown to whoever can take it. */
export function NextStep({ org, run, chain }: { org: Organization; run: PayrollRunDetail; chain: Chain }) {
  const w = useWallet();
  if (!isDeployed) {
    return (
      <Panel title="On-chain steps are turned off">
        <Blocked>PayFlow contracts are not deployed on this environment, so this run can&apos;t go on-chain yet. The draft is saved.</Blocked>
      </Panel>
    );
  }
  if (org.status !== "active" || !org.chainOrgId) {
    return (
      <Panel title="Register the organization first">
        <Blocked>This organization isn&apos;t registered on Mezo yet. The owner can register it from the banner at the top of the page.</Blocked>
      </Panel>
    );
  }
  if (!w.isConnected) return <Panel title="Connect your wallet">{<Blocked>Connect the wallet you signed in with to take the next step.</Blocked>}</Panel>;

  switch (run.status) {
    case "draft":
    case "onchain_draft":
      if (!canContinueBuild(run)) {
        return (
          <Panel title="Run blocked">
            <Blocked>{stepBlock(run, "approve")}</Blocked>
          </Panel>
        );
      }
      return <BuildPanel org={org} run={run} />;
    case "pending_approval":
      return <ApprovePanel org={org} run={run} chain={chain} />;
    case "approved":
      return <FundPanel org={org} run={run} chain={chain} />;
    case "funded":
      return <PublishPanel org={org} run={run} />;
    case "published":
    case "partially_claimed":
      return <OpenPanel org={org} run={run} chain={chain} />;
    case "completed":
      return (
        <Panel title="All payments claimed">
          <Blocked>Every recipient has claimed. Nothing else to do.</Blocked>
        </Panel>
      );
    case "expired":
    case "cancelled":
      return <RefundPanel org={org} run={run} chain={chain} />;
  }
}

/* ---------------- 5: create run + add payments + submit ---------------- */

function BuildPanel({ org, run }: { org: Organization; run: PayrollRunDetail }) {
  const qc = useQueryClient();
  const tx = useRunTx(org.id, run.id);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const can = canOperate(org.myRoles);
  const totalBatches = Math.max(1, Math.ceil(run.recipientCount / 100));

  async function plan() {
    return api<RunChainPlan>(`/api/orgs/${org.id}/runs/${run.id}/plan`);
  }

  async function go() {
    setError(null);
    try {
      setPhase("Preparing");
      let p = await plan();
      if (!p.chainRunId) {
        const res = await tx.send("create", build.createRun(BigInt(org.chainOrgId!), p.runRef, p.claimWindowSeconds), { silent: true, progress: "Step 1: create the run" });
        if (!res?.recorded) return setPhase(null);
        p = await plan();
        if (!p.chainRunId) throw new Error("The run was created on-chain but PayFlow hasn't picked it up yet. Refresh in a moment.");
      }
      const runId = BigInt(p.chainRunId);
      const done = totalBatches - p.batches.length;
      for (let i = 0; i < p.batches.length; i++) {
        const b = p.batches[i];
        const label = `Batch ${done + i + 1} of ${totalBatches}`;
        setPhase(label);
        const res = await tx.send(
          "allocate",
          build.addPayments(runId, b.expectedIndex, b.recipients as Address[], b.amounts.map((a) => BigInt(a)), "Add payments"),
          { silent: true, progress: label },
        );
        if (!res?.recorded) return setPhase(null);
      }
      setPhase("Submitting");
      const res = await tx.send("submit", build.submitForApproval(runId), { successMessage: "Sent for approval", progress: "Last step: submit for approval" });
      if (res?.recorded) await qc.invalidateQueries({ queryKey: ["api", "org", org.id] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPhase(null);
    }
  }

  return (
    <Panel title={run.status === "draft" ? "Next: add this run on-chain" : "Next: finish adding payments"} tone="attention">
      <p className="text-muted-foreground">
        {run.status === "draft"
          ? `This sends ${totalBatches + 2} transactions from your wallet: create the run, add ${run.recipientCount.toLocaleString()} payments in ${totalBatches} ${totalBatches === 1 ? "batch" : "batches"} of up to 100, then submit it for approval. No MUSD moves yet.`
          : "Some payments are already on-chain. Continue to add the rest, then submit for approval. Re-sent batches are rejected, so nothing is added twice."}
      </p>
      {!can ? (
        <Blocked>You need the operator or admin role to do this.</Blocked>
      ) : (
        <Button onClick={() => void go()} disabled={Boolean(phase) || tx.isBusy}>
          {phase ? `${phase}…` : run.status === "draft" ? "Add on-chain and submit" : "Continue"}
        </Button>
      )}
      <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} />
      {error ? <p className="text-bad">{error}</p> : null}
    </Panel>
  );
}

/* ---------------- 6: approval ---------------- */

export function recomputeHash(run: PayrollRunDetail): Hex | null {
  if (!run.chainRunId) return null;
  const onchain = run.items.filter((i) => i.paymentId !== null).sort((a, b) => a.index - b.index);
  const ops: CommitmentOp[] = onchain.map((i) => ({ kind: "add", index: i.index, recipient: i.recipientAddress as Address, amount: BigInt(i.amount) }));
  for (const i of onchain) if (i.claimStatus === "cancelled") ops.push({ kind: "cancel", index: i.index });
  return paymentsHash(MEZO_TESTNET_ID, contracts.escrow, BigInt(run.chainRunId), run.claimWindowDays * 86400, ops);
}

function ApprovePanel({ org, run, chain }: { org: Organization; run: PayrollRunDetail; chain: Chain }) {
  const tx = useRunTx(org.id, run.id);
  const [reason, setReason] = useState("");
  const [showReturn, setShowReturn] = useState(false);
  const local = useMemo(() => recomputeHash(run), [run]);
  const onchain = chain.run?.paymentsHash as Hex | undefined;
  const total = run.items.filter((i) => i.claimStatus !== "cancelled").reduce((n, i) => n + BigInt(i.amount), 0n);
  const allocated = chain.run ? BigInt(chain.run.allocated) : undefined;
  const mismatch = hasChainMismatch(run);
  // A server-reported mismatch overrides the local fingerprint check: never show "matches" then.
  const hashOk = !mismatch && Boolean(local && onchain && local.toLowerCase() === onchain.toLowerCase());
  // Count and total are labelled on their own facts; a mismatch still blocks approval below.
  const { countOk, totalOk } = approvalCountsMatch(
    chain.run ? Number(chain.run.paymentCount) : undefined,
    run.items.filter((i) => i.paymentId !== null).length,
    allocated,
    total,
  );
  const block = stepBlock(run, "approve");
  const ready = !mismatch && hashOk && totalOk === true && countOk === true && !block;
  const valid = run.validApprovals ?? (chain.run ? Number(chain.run.approvals) : null);
  const required = run.approvalsRequired ?? (chain.run ? Number(chain.run.approvalsRequired) : null);
  const approvals = valid !== null && required !== null ? `${valid} of ${required}` : "…";
  const reviewed = run.items.filter((i) => i.paymentId !== null && i.claimStatus !== "cancelled").sort((a, b) => a.index - b.index);

  return (
    <Panel title="Next: approval" tone="attention">
      <p className="text-muted-foreground">
        An approver checks that the payments recorded on-chain match this list exactly, then signs. Approvals so far: <span className="num font-medium text-foreground">{approvals}</span>.
      </p>
      <dl className="divide-y rounded-md border bg-background text-[0.8125rem]">
        <Check label="Payments on-chain" value={chain.run ? `${chain.run.paymentCount}` : "…"} ok={countOk} />
        <Check label="Total on-chain" value={allocated !== undefined ? `${formatMusd(allocated)} MUSD` : "…"} ok={totalOk} />
        <div className="grid gap-1 px-3 py-2">
          <dt className="flex items-center justify-between">
            <span className="text-muted-foreground">Payment list fingerprint</span>
            <span className={cn("font-medium", mismatch ? "text-bad" : !onchain ? "text-muted-foreground" : hashOk ? "text-ok" : "text-bad")}>
              {mismatch ? "Does not match the reviewed list" : !onchain ? "Reading…" : hashOk ? "Matches this list" : "Does not match"}
            </span>
          </dt>
          <dd className="flex items-center gap-1 font-mono text-xs break-all text-muted-foreground">
            {onchain ?? ""}
            {onchain ? <CopyButton value={onchain} label="Copy fingerprint" /> : null}
          </dd>
        </div>
      </dl>
      {mismatch ? (
        <p className="font-medium text-bad">Don&apos;t approve. {block}</p>
      ) : !ready && chain.run ? (
        <p className="text-bad">Don&apos;t approve: what&apos;s on-chain differs from the list below. Return it to draft, or sync the run and check again.</p>
      ) : null}
      <details className="rounded-md border bg-background text-[0.8125rem]" open={mismatch || reviewed.length <= 5}>
        <summary className="cursor-pointer px-3 py-2 font-medium">What you&apos;re approving: {reviewed.length.toLocaleString()} {reviewed.length === 1 ? "payment" : "payments"}</summary>
        <ul className="max-h-64 divide-y overflow-y-auto border-t">
          {reviewed.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0">
                <span className="block truncate">{i.name}</span>
                <span className="block font-mono text-xs text-muted-foreground" title={checksum(i.recipientAddress)}>{shortAddress(checksum(i.recipientAddress), 6)}</span>
              </span>
              <Musd wei={i.amount} className="shrink-0" />
            </li>
          ))}
        </ul>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        {canApprove(org.myRoles) ? (
          chain.iApproved ? (
            <p className="text-muted-foreground">You approved this run. Waiting for the other approvers.</p>
          ) : (
            <Button disabled={!ready || tx.isBusy} onClick={() => chain.runId && onchain && void tx.send("approve", build.approve(chain.runId, onchain), { successMessage: "Run approved" }).then(() => chain.refetch())}>
              Approve {formatMusd(total)} MUSD
            </Button>
          )
        ) : (
          <Blocked>Waiting for an approver.</Blocked>
        )}
        {canReturn(org.myRoles, run.status) ? (
          <Button variant="outline" disabled={tx.isBusy} onClick={() => setShowReturn((v) => !v)}>
            Return to draft
          </Button>
        ) : null}
        <a href={`/api/orgs/${org.id}/runs/${run.id}/manifest`} target="_blank" rel="noreferrer" className="text-[0.8125rem] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Download manifest
        </a>
      </div>
      {showReturn ? (
        <div className="space-y-2 rounded-md border bg-background p-3">
          <label htmlFor="return-reason" className="text-[0.8125rem] font-medium">
            Reason <span className="font-normal text-muted-foreground">(shared with the team)</span>
          </label>
          <Textarea id="return-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button
            variant="outline"
            size="sm"
            disabled={tx.isBusy || !chain.runId}
            onClick={() => chain.runId && void tx.send("return", build.returnToDraft(chain.runId), { rejectionReason: reason.trim() || undefined, successMessage: "Returned to draft" })}
          >
            Confirm return to draft
          </Button>
        </div>
      ) : null}
      <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} />
    </Panel>
  );
}

function Check({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="num flex items-center gap-2">
        {value}
        {ok === undefined ? null : <span className={ok ? "text-ok" : "text-bad"}>{ok ? "matches" : "differs"}</span>}
      </dd>
    </div>
  );
}

/* ---------------- 7: fund ---------------- */

function FundPanel({ org, run, chain }: { org: Organization; run: PayrollRunDetail; chain: Chain }) {
  const w = useWallet();
  const config = useConfig();
  const client = usePublicClient({ chainId: MEZO_TESTNET_ID });
  const { signTypedDataAsync } = useSignTypedData();
  const tx = useRunTx(org.id, run.id);
  const [chosenMode, setMode] = useState<"permit" | "approve">("permit");
  // MUSD's permit checks an ECDSA signature from the owner, which a Mezo Passport smart account can't give.
  const mode = w.isSmartAccount ? "approve" : chosenMode;
  const [gas, setGas] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const block = stepBlock(run, "fund");
  const required = chain.run ? BigInt(chain.run.allocated) - BigInt(chain.run.funded) : BigInt(run.totalAmount);
  const me = w.address;

  const musd = useReadContract({ address: contracts.musd, abi: erc20Abi, functionName: "balanceOf", args: me ? [me] : undefined, chainId: MEZO_TESTNET_ID, query: { enabled: Boolean(me) } });
  const allowance = useReadContract({ address: contracts.musd, abi: erc20Abi, functionName: "allowance", args: me ? [me, contracts.escrow] : undefined, chainId: MEZO_TESTNET_ID, query: { enabled: Boolean(me) } });
  const btc = useBalance({ address: me, chainId: MEZO_TESTNET_ID, query: { enabled: Boolean(me) } });

  const balance = musd.data;
  const enoughMusd = balance !== undefined && balance >= required;
  const allowanceOk = allowance.data !== undefined && allowance.data >= required;
  const lowGas = btc.data !== undefined && btc.data.value === 0n;

  async function estimate() {
    if (!client || !me || !chain.runId) return;
    try {
      const price = await client.getGasPrice();
      const g = allowanceOk
        ? await client.estimateContractGas({ address: contracts.escrow, abi: build.fund(chain.runId).abi, functionName: "fund", args: [chain.runId], account: me })
        : await client.estimateContractGas({ address: contracts.musd, abi: erc20Abi, functionName: "approve", args: [contracts.escrow, required], account: me });
      const btc = Number(formatUnits(g * price, 18)).toPrecision(2);
      setGas(allowanceOk ? `about ${btc} BTC` : `about ${btc} BTC to allow MUSD, then a similar fee to fund`);
    } catch (e) {
      setGas(describeTxError(e).message);
    }
  }

  /** Re-read the balance right before funding: it may have changed since the page loaded. */
  async function balanceOk(): Promise<boolean> {
    if (!me) return false;
    try {
      const fresh = await readContract(config, { address: contracts.musd, abi: erc20Abi, functionName: "balanceOf", args: [me], chainId: MEZO_TESTNET_ID });
      void musd.refetch();
      if (fresh < required) {
        setNote(`You have ${formatMusd(fresh)} MUSD; this run needs ${formatMusd(required)} MUSD. Add ${formatMusd(required - fresh)} MUSD to this wallet or fund from another admin wallet.`);
        return false;
      }
      return true;
    } catch (e) {
      setNote(`Couldn't check your MUSD balance: ${describeTxError(e).message}`);
      return false;
    }
  }

  async function afterFailure() {
    await Promise.all([musd.refetch(), allowance.refetch(), btc.refetch(), chain.refetch()]);
  }

  async function fund() {
    if (!me || !chain.runId || block) return;
    setNote(null);
    if (!(await balanceOk())) return;
    const runId = chain.runId;
    if (allowanceOk) {
      if (!(await tx.send("fund", build.fund(runId), { successMessage: "Run funded" }))) await afterFailure();
      return;
    }
    if (mode === "permit") {
      try {
        const nonce = await readContract(config, { address: contracts.musd, abi: erc20Abi, functionName: "nonces", args: [me], chainId: MEZO_TESTNET_ID });
        const deadline = permitDeadline();
        const sig = await signTypedDataAsync(permitTypedData(me, required, nonce, deadline));
        const { r, s, v, yParity } = parseSignature(sig);
        const vNum = v !== undefined ? Number(v) : yParity + 27;
        if (!(await tx.send("fund", build.fundWithPermit(runId, deadline, vNum, r, s), { successMessage: "Run funded" }))) await afterFailure();
        return;
      } catch (e) {
        const d = describeTxError(e);
        if (d.kind === "rejected") {
          setNote("Signature cancelled. You can sign again, or use a separate approval transaction instead.");
          return;
        }
        setNote("Your wallet couldn't sign a permit, so PayFlow will use a separate approval transaction.");
        setMode("approve");
      }
    }
    const a = await tx.run(build.approveMusd(required), { silent: true, progress: "Step 1 of 2" });
    if (!a) return void (await afterFailure());
    await allowance.refetch();
    if (!(await balanceOk())) return;
    if (!(await tx.send("fund", build.fund(runId), { successMessage: "Run funded", progress: "Step 2 of 2" }))) await afterFailure();
  }

  const admin = canAdmin(org.myRoles);
  return (
    <Panel title="Next: fund the escrow" tone="attention">
      <p className="text-muted-foreground">An admin moves the run total from their wallet into the escrow. Recipients can&apos;t claim until you publish.</p>
      <dl className="divide-y rounded-md border bg-background text-[0.8125rem]">
        <Row label="Required" value={`${formatMusd(required)} MUSD`} strong />
        <Row label="Your MUSD balance" value={balance === undefined ? "…" : `${formatMusd(balance)} MUSD`} bad={balance !== undefined && !enoughMusd} />
        <Row label="Already allowed for PayFlow" value={allowance.data === undefined ? "…" : `${formatMusd(allowance.data)} MUSD`} />
        <Row label="Your BTC for fees" value={btc.data ? `${Number(formatUnits(btc.data.value, 18)).toPrecision(3)} BTC` : "…"} bad={lowGas} />
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <dt className="text-muted-foreground">Network fee</dt>
          <dd>
            {gas ?? (
              <button type="button" onClick={() => void estimate()} className="cursor-pointer underline underline-offset-4">
                Estimate
              </button>
            )}
          </dd>
        </div>
      </dl>
      {block ? <p className="font-medium text-bad">{block}</p> : null}
      {balance !== undefined && !enoughMusd ? (
        <p className="text-bad">
          You have {formatMusd(balance)} MUSD; this run needs {formatMusd(required)} MUSD. Add {formatMusd(required - balance)} MUSD to this wallet or fund from another admin wallet.
        </p>
      ) : null}
      {lowGas ? <p className="text-bad">This wallet has no BTC to pay network fees.</p> : null}
      {admin ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!enoughMusd || Boolean(block) || tx.isBusy || !w.isReady} onClick={() => void fund()}>
            Fund {formatMusd(required)} MUSD
          </Button>
          {!allowanceOk && !w.isSmartAccount ? (
            <label className="flex cursor-pointer items-center gap-2 text-[0.8125rem] text-muted-foreground">
              <input type="checkbox" checked={mode === "approve"} onChange={(e) => setMode(e.target.checked ? "approve" : "permit")} className="accent-[var(--foreground)]" />
              Use a separate approval transaction
            </label>
          ) : null}
        </div>
      ) : (
        <Blocked>Waiting for an admin to fund this run.</Blocked>
      )}
      <p className="text-[0.8125rem] text-muted-foreground">
        {allowanceOk
          ? "Your allowance already covers this, so funding is one transaction."
          : mode === "permit"
            ? "You'll sign a permit, which costs nothing, then send one funding transaction. The network fee above is an estimate for a separate approval; with a permit you only pay the funding fee."
            : "You'll send two transactions: allow MUSD, then fund. Each has a small network fee."}
      </p>
      {note ? <p className="text-[0.8125rem]">{note}</p> : null}
      <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} />
    </Panel>
  );
}

function Row({ label, value, strong, bad }: { label: string; value: string; strong?: boolean; bad?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("num text-right", strong && "font-semibold", bad && "text-bad")}>{value}</dd>
    </div>
  );
}

/* ---------------- 8: publish ---------------- */

function PublishPanel({ org, run }: { org: Organization; run: PayrollRunDetail }) {
  const tx = useRunTx(org.id, run.id);
  const [confirming, setConfirming] = useState(false);
  const runId = run.chainRunId ? BigInt(run.chainRunId) : null;
  const block = stepBlock(run, "publish");
  const payees = run.items.filter((i) => i.paymentId !== null && i.claimStatus !== "cancelled").sort((a, b) => a.index - b.index);
  const total = payees.reduce((n, i) => n + BigInt(i.amount), 0n);
  const now = useNow();
  const closes = now ? new Date(now + run.claimWindowDays * 864e5).toISOString() : null;
  return (
    <Panel title="Next: publish" tone="attention">
      <p className="text-muted-foreground">
        Publishing opens claims for {run.claimWindowDays} days and notifies recipients. After this, payments can&apos;t be cancelled or pulled back until the window ends.
      </p>
      {block ? <p className="font-medium text-bad">{block}</p> : null}
      {canAdmin(org.myRoles) ? (
        <Button disabled={tx.isBusy || !runId || Boolean(block)} onClick={() => setConfirming(true)}>
          Publish and open claims
        </Button>
      ) : (
        <Blocked>Waiting for an admin to publish.</Blocked>
      )}
      <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} />
      <p className="text-[0.8125rem] text-muted-foreground">Need to change who gets paid? Cancel the whole run below (the funder gets a full refund) and build a new one.</p>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Publish ${run.name}?`}
        description="This can't be undone."
        confirmLabel={`Publish ${formatMusd(total)} MUSD`}
        onConfirm={() => runId && !block && void tx.send("publish", build.publish(runId), { successMessage: "Published. Recipients can claim now." })}
      >
        <p>
          <span className="num font-medium">{payees.length.toLocaleString()}</span> {payees.length === 1 ? "person gets" : "people get"} paid a total of{" "}
          <span className="num font-medium">{formatMusd(total)} MUSD</span>.
        </p>
        <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-[0.8125rem]">
          {payees.slice(0, 50).map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="truncate">{i.name}</span>
              <Musd wei={i.amount} className="shrink-0" />
            </li>
          ))}
          {payees.length > 50 ? <li className="px-3 py-1.5 text-muted-foreground">and {(payees.length - 50).toLocaleString()} more</li> : null}
        </ul>
        <p>
          They can claim for {run.claimWindowDays} {run.claimWindowDays === 1 ? "day" : "days"}{closes ? `, until about ${formatDate(closes)}` : ""}. After that, anyone (a recipient too, from their claim page) can close the run and an admin can refund what&apos;s left.
        </p>
        <p className="font-medium">Once published, payments can&apos;t be cancelled or pulled back until the claim window ends.</p>
      </ConfirmDialog>
    </Panel>
  );
}

/* ---------------- 9: track, expire, refund ---------------- */

function OpenPanel({ org, run, chain }: { org: Organization; run: PayrollRunDetail; chain: Chain }) {
  const tx = useRunTx(org.id, run.id);
  const w = useWallet();
  const now = useNow();
  const deadline = chain.run ? Number(chain.run.claimDeadline) * 1000 : run.claimDeadline ? new Date(run.claimDeadline).getTime() : null;
  const passed = deadline !== null && now > 0 && now > deadline;
  const showExpire = canExpire(run, deadline, now, w.isConnected) && Boolean(chain.runId);

  function expire() {
    // Anyone may expire after the deadline. Admins record it via /tx; for others a sync re-reads the run.
    void tx.run(build.expireRun(chain.runId!), {
      successMessage: "Run expired. Unclaimed MUSD can now be refunded by an admin.",
      record: async (hash) => {
        try {
          return await api(`/api/orgs/${org.id}/runs/${run.id}/tx`, { method: "POST", json: { action: "expire", txHash: hash } });
        } catch {
          return await api(`/api/orgs/${org.id}/runs/${run.id}/sync`, { method: "POST", json: {} });
        }
      },
    });
  }

  return (
    <Panel title={passed ? "Claim window has ended" : "Open for claims"}>
      <p className="text-muted-foreground">
        {run.claimedCount.toLocaleString()} of {run.recipientCount.toLocaleString()} recipients have claimed.{" "}
        {deadline
          ? passed
            ? "Anyone, including a recipient from their claim page, can close the run now. After that, an admin can refund what wasn't claimed."
            : `Claims close on ${new Date(deadline).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`
          : null}
      </p>
      {showExpire ? (
        <Button disabled={tx.isBusy || !w.isReady} onClick={expire}>
          Close the run
        </Button>
      ) : null}
      <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} />
    </Panel>
  );
}

function RefundPanel({ org, run, chain }: { org: Organization; run: PayrollRunDetail; chain: Chain }) {
  const tx = useRunTx(org.id, run.id);
  const [confirming, setConfirming] = useState(false);
  const refundable = chain.refundable ?? 0n;
  return (
    <Panel title={run.status === "cancelled" ? "Run cancelled" : "Run closed"}>
      {refundable > 0n ? (
        <>
          <p className="text-muted-foreground">
            <span className="num font-medium text-foreground">{formatMusd(refundable)} MUSD</span> can be refunded. It always goes back to the wallet that funded the run
            {run.funderWallet ? <span className="font-mono"> ({run.funderWallet.slice(0, 8)}…)</span> : null}.
          </p>
          {chain.runId ? (
            <Button disabled={tx.isBusy} onClick={() => setConfirming(true)}>
              Refund {formatMusd(refundable)} MUSD
            </Button>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground">{chain.run ? "Nothing left to refund." : run.chainRunId ? "Checking the escrow…" : "This run never reached the chain."}</p>
      )}
      <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Refund ${formatMusd(refundable)} MUSD?`}
        description="This can't be undone."
        confirmLabel={`Refund ${formatMusd(refundable)} MUSD`}
        onConfirm={() => chain.runId && void tx.send("refund", build.refund(chain.runId), { successMessage: "Refund sent" }).then(() => chain.refetch())}
      >
        <p>
          The MUSD goes back to the wallet that funded this run
          {run.funderWallet ? (
            <>
              , <span className="font-mono">{shortAddress(checksum(run.funderWallet), 6)}</span>
            </>
          ) : null}
          . It can&apos;t be sent anywhere else, and recipients who didn&apos;t claim won&apos;t be able to claim afterwards.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}

/** Cancel the whole run (before publish). A funded run can only be cancelled whole, by an admin, for a full refund. */
export function AdminCancelRun({ org, run, chain, variant = "link" }: { org: Organization; run: PayrollRunDetail; chain: Chain; variant?: "link" | "button" }) {
  const tx = useRunTx(org.id, run.id);
  const [confirming, setConfirming] = useState(false);
  const funded = run.status === "funded";
  if (!chain.runId || !canCancelRun(run, org.myRoles)) return null;
  const amount = BigInt(run.fundedAmount || "0");
  return (
    <div className={variant === "link" ? "border-t pt-3" : undefined}>
      {variant === "link" ? (
        <button type="button" onClick={() => setConfirming(true)} className="cursor-pointer text-[0.8125rem] text-bad underline-offset-4 hover:underline">
          Cancel this run
        </button>
      ) : (
        <Button variant="destructive" disabled={tx.isBusy} onClick={() => setConfirming(true)}>
          Cancel run
        </Button>
      )}
      <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} className="mt-2" />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Cancel ${run.name}?`}
        description="This can't be undone. Nobody in this run gets paid from it."
        confirmLabel="Cancel run"
        cancelLabel="Keep it"
        destructive
        onConfirm={() => chain.runId && void tx.send("cancel", build.cancelRun(chain.runId), { successMessage: "Run cancelled" })}
      >
        <p>
          {funded
            ? `All ${formatMusd(amount)} MUSD in the escrow becomes refundable to the wallet that funded it. Anyone in the team can send the refund in one more step.`
            : "No MUSD has moved yet, so there is nothing to refund."}
        </p>
        <p>To pay these people, build a new run.</p>
      </ConfirmDialog>
    </div>
  );
}
