"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ClipboardList, Download, Link2, MoreHorizontal, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { ItemClaimStatus, Member, Organization, PayrollItem, PayrollRunDetail } from "@/lib/api-types";
import { contracts, explorerAddress, ROLE } from "@/lib/chain/config";
import { api, ApiClientError, downloadFromApi, errorMessage, isChainUnavailable } from "@/lib/client/api";
import { CATEGORY_LABEL, formatDate, relativeTime, shortAddress } from "@/lib/client/format";
import { canCancelPayment, canCancelRun, checksum, claimLinksTsv, hasChainMismatch, approvalsShortfall, mismatchSummary, windowLabel } from "@/lib/client/run-gates";
import { canOperate, has } from "@/lib/client/roles";
import { claimsLabel, itemStatus, RUN_STATUS, timelineSteps } from "@/lib/client/status";
import { cn } from "@/lib/client/utils";
import { build } from "@/lib/client/writes";
import { isRpcUnreachable } from "@/lib/client/errors";
import { useMembers, useRun } from "@/hooks/use-api";
import { useWallet } from "@/hooks/use-wallet";
import { useRunChain } from "@/hooks/use-run-chain";
import { useOrg } from "@/components/org/org-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Section } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/empty-state";
import { ChainBanner, DataAge, useRpcDown } from "@/components/shared/chain-banner";
import { StatusDot } from "@/components/shared/status-dot";
import { Musd } from "@/components/shared/money";
import { Address, CopyButton, TxLink } from "@/components/shared/address";
import { TxStatus } from "@/components/shared/tx-status";
import { AdminCancelRun, NextStep } from "./next-step";
import { useRunTx } from "./use-run-tx";

type ItemFilter = "all" | ItemClaimStatus;
const PAGE = 50;

export function RunDetailView({ runId }: { runId: string }) {
  const org = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const w = useWallet();
  const q = useRun(org.id, runId);
  const run = q.data;
  const chain = useRunChain(run?.chainRunId, w.address);
  const rpcDown = useRpcDown();
  const base = `/app/${org.slug}`;

  const sync = useMutation({
    mutationFn: () => api<PayrollRunDetail>(`/api/orgs/${org.id}/runs/${runId}/sync`, { method: "POST", json: {} }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["api", "org", org.id] });
      await chain.refetch();
      toast.success("Synced with the chain");
    },
    onError: (e) => toast.error("Sync failed", { description: errorMessage(e) }),
  });
  const del = useMutation({
    mutationFn: () => api<unknown>(`/api/orgs/${org.id}/runs/${runId}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success("Draft deleted");
      await qc.invalidateQueries({ queryKey: ["api", "org", org.id] });
      router.push(`${base}/runs`);
    },
    onError: (e) => toast.error("Couldn't delete", { description: errorMessage(e) }),
  });

  if (q.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!run) {
    const notFound = q.error instanceof ApiClientError && (q.error.code === "not_found" || q.error.code === "invalid_input");
    if (notFound) {
      return (
        <div className="max-w-lg py-6">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">Run not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">This payroll run doesn&apos;t exist in {org.name}, or it was a draft that has been deleted.</p>
          <Button asChild variant="outline" className="mt-6">
            <Link href={`${base}/runs`}>
              <ArrowLeft data-icon="inline-start" /> Back to payroll runs
            </Link>
          </Button>
        </div>
      );
    }
    if (isChainUnavailable(q.error)) return <ChainBanner hasData={false} />;
    return (
      <Section>
        <ErrorState title="Couldn't load this run" message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      </Section>
    );
  }

  const status = RUN_STATUS[run.status];
  const refundable = chain.refundable;
  const offline = rpcDown || isChainUnavailable(q.error) || Boolean(run.chainRunId && isRpcUnreachable(chain.error));

  return (
    <div className="space-y-6">
      <div>
        <Link href={`${base}/runs`} className="inline-flex items-center gap-1 text-[0.8125rem] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Payroll runs
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-[-0.01em]">{run.name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <StatusDot tone={status.tone} label={status.label} className="text-foreground" />
              <span>{CATEGORY_LABEL[run.paymentCategory]}</span>
              <span>Created {formatDate(run.createdAt)}</span>
              {run.scheduledAt ? <span>Pay date {formatDate(run.scheduledAt)}</span> : null}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="outline" onClick={() => downloadFromApi(`/api/orgs/${org.id}/runs/${run.id}/export`, `${org.slug}-${run.name.replace(/\W+/g, "-").toLowerCase()}.csv`).catch((e) => toast.error("Export failed", { description: errorMessage(e) }))}>
              <Download data-icon="inline-start" /> Export CSV
            </Button>
            {run.chainRunId ? (
              <Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
                <RefreshCw data-icon="inline-start" className={sync.isPending ? "animate-spin" : undefined} /> Sync
              </Button>
            ) : null}
            {run.status === "draft" && canOperate(org.myRoles) ? (
              <Button variant="ghost" className="text-bad" disabled={del.isPending} onClick={() => confirm("Delete this draft? This can't be undone.") && del.mutate()}>
                Delete draft
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {params.get("created") === "1" && run.status === "draft" ? (
        <p role="status" className="rounded-md border bg-surface px-3 py-2 text-sm">
          Draft saved with {run.recipientCount.toLocaleString()} payments. Next, add it on-chain and send it for approval.
        </p>
      ) : null}

      {offline ? <ChainBanner hasData updatedAt={chain.updatedAt ?? q.dataUpdatedAt} /> : null}

      {hasChainMismatch(run) ? <MismatchPanel org={org} run={run} chain={chain} /> : null}

      <Timeline run={run} />

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
            {[
              ["Total", <Musd key="t" wei={run.totalAmount} />, `${run.recipientCount.toLocaleString()} recipients`],
              ["Funded", <Musd key="f" wei={run.fundedAmount} />, run.funderWallet ? `by ${shortAddress(checksum(run.funderWallet))}` : "Not yet"],
              ["Claimed", <Musd key="c" wei={run.claimedAmount} />, claimsLabel(run.claimedCount)],
              [
                run.status === "published" || run.status === "partially_claimed" ? "Outstanding" : "Refundable",
                run.status === "published" || run.status === "partially_claimed" ? (
                  <Musd key="o" wei={run.outstandingAmount} />
                ) : refundable !== undefined ? (
                  <Musd key="r" wei={refundable} />
                ) : (
                  <Musd key="r2" wei={null} />
                ),
                run.claimDeadline ? `Claims close ${formatDate(run.claimDeadline)}` : `${run.claimWindowDays}-day claim window`,
              ],
            ].map(([label, value, hint]) => (
              <div key={String(label)} className="bg-background px-4 py-3.5">
                <dt className="text-[0.8125rem] text-muted-foreground">{label}</dt>
                <dd className="mt-1 truncate text-base font-semibold">{value}</dd>
                <dd className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</dd>
              </div>
            ))}
          </dl>
          <ItemsTable run={run} />
          <p className="text-xs text-muted-foreground">
            <DataAge at={q.dataUpdatedAt} prefix="PayFlow data updated" />
            {chain.updatedAt ? (
              <>
                {" "}
                <DataAge at={chain.updatedAt} prefix="Chain read" />
              </>
            ) : null}
          </p>
        </div>

        <aside className="min-w-0 space-y-6">
          <NextStep org={org} run={run} chain={chain} />
          <AdminCancelRunBox run={run} chain={chain} />
          <OnChainRecord run={run} />
          {run.approvals.length || run.validApprovals !== null ? <Approvals org={org} run={run} /> : null}
        </aside>
      </div>
    </div>
  );
}

function AdminCancelRunBox({ run, chain }: { run: PayrollRunDetail; chain: ReturnType<typeof useRunChain> }) {
  const org = useOrg();
  if (!chain.runId || hasChainMismatch(run) || !canCancelRun(run, org.myRoles)) return null;
  return (
    <div className="px-1">
      <AdminCancelRun org={org} run={run} chain={chain} />
    </div>
  );
}

function Timeline({ run }: { run: PayrollRunDetail }) {
  const steps = timelineSteps(run.status);
  return (
    <ol aria-label="Run progress" className="flex flex-wrap items-center gap-x-1 gap-y-2 rounded-lg border px-4 py-3 text-[0.8125rem]">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1" aria-current={s.state === "current" ? "step" : undefined}>
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1",
              s.state === "done" && "text-foreground",
              s.state === "current" && "bg-foreground font-medium text-background",
              s.state === "todo" && "text-muted-foreground/80",
            )}
          >
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", s.state === "done" ? "bg-ok" : s.state === "current" ? "bg-brand" : "border border-muted-foreground/50 bg-transparent")}
            />
            {s.label}
            <span className="sr-only">{s.state === "done" ? " (done)" : s.state === "current" ? " (current step)" : " (not yet)"}</span>
          </span>
          {i < steps.length - 1 ? <span aria-hidden className={cn("h-px w-3 sm:w-5", s.state === "done" ? "bg-foreground/30" : "bg-border")} /> : null}
        </li>
      ))}
      {run.status === "cancelled" ? (
        <li className="ml-2 flex items-center gap-1.5 font-medium text-bad">
          <span aria-hidden className="size-1.5 rounded-full bg-bad" />
          Cancelled
        </li>
      ) : null}
      {run.status === "expired" ? <li className="ml-2 font-medium text-muted-foreground">Expired: claim window closed</li> : null}
    </ol>
  );
}

/** Blocking panel: the on-chain allocation differs from what people reviewed. */
function MismatchPanel({ org, run, chain }: { org: Organization; run: PayrollRunDetail; chain: ReturnType<typeof useRunChain> }) {
  const windowRow = run.chainMismatch.find((m) => m.kind === "claim_window");
  const rows = run.chainMismatch.filter((m) => m.kind !== "claim_window");
  const closed = run.status === "cancelled";
  return (
    <section role={closed ? "status" : "alert"} className={cn("rounded-lg p-4 sm:p-5", closed ? "border bg-surface" : "border-2 border-bad bg-bad/[0.05]")}>
      <h2 className={cn("text-base font-semibold", !closed && "text-bad")}>
        {closed ? "This run was blocked and is now cancelled" : "Stop: the payments on-chain don't match what was reviewed"}
      </h2>
      <p className="mt-1 max-w-[70ch] text-sm">
        {mismatchSummary(rows.length, closed, Boolean(windowRow))}
      </p>
      {windowRow ? (
        <p className="mt-3 rounded-md border border-bad/30 bg-background px-3 py-2.5 text-[0.8125rem]">
          <span className="font-medium">Claim window: </span>
          {windowLabel(windowRow.reviewedClaimWindowSeconds ?? 0)} <span aria-hidden>→</span>
          <span className="sr-only">on-chain</span> <span className="font-semibold text-bad">{windowLabel(windowRow.chainClaimWindowSeconds ?? 0)}</span>
          {windowRow.txHash ? <span className="ml-2"><TxLink hash={windowRow.txHash} /></span> : null}
        </p>
      ) : null}
      {rows.length ? (
      <ul className="mt-3 divide-y overflow-hidden rounded-md border border-bad/30 bg-background text-[0.8125rem]">
        {rows.map((m) => {
          const walletDiffers = m.reviewedRecipient.toLowerCase() !== m.chainRecipient.toLowerCase();
          const amountDiffers = m.reviewedAmount !== m.chainAmount;
          return (
            <li key={m.index} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[minmax(8rem,1fr)_2fr_1.4fr_auto] sm:items-center sm:gap-3">
              <p className="font-medium">
                {m.name} <span className="num font-normal text-muted-foreground">#{m.index + 1}</span>
              </p>
              <p className={cn("flex flex-wrap items-center gap-x-1.5 font-mono text-xs", walletDiffers && "text-bad")}>
                <span title={checksum(m.reviewedRecipient)}>{shortAddress(checksum(m.reviewedRecipient), 6)}</span>
                <span aria-hidden>→</span>
                <span className="sr-only">on-chain</span>
                <span title={checksum(m.chainRecipient)} className={walletDiffers ? "font-semibold" : undefined}>{shortAddress(checksum(m.chainRecipient), 6)}</span>
              </p>
              <p className={cn("flex flex-wrap items-center gap-x-1.5", amountDiffers && "text-bad")}>
                <Musd wei={m.reviewedAmount} />
                <span aria-hidden>→</span>
                <span className="sr-only">on-chain</span>
                <Musd wei={m.chainAmount} className={amountDiffers ? "font-semibold" : undefined} />
              </p>
              <p>{m.txHash ? <TxLink hash={m.txHash} /> : <span className="text-muted-foreground">-</span>}</p>
            </li>
          );
        })}
      </ul>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">Reviewed → on-chain. Highlighted values differ.</p>
      {closed ? null : (
        <div className="mt-4">
          {canCancelRun(run, org.myRoles) ? (
            <AdminCancelRun org={org} run={run} chain={chain} variant="button" />
          ) : (
            <p className="text-sm text-muted-foreground">
              {run.status === "funded" ? "Ask an admin to cancel this run. The funder gets a full refund." : "Ask an operator or admin to cancel this run."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function OnChainRecord({ run }: { run: PayrollRunDetail }) {
  const itemTxs = Array.from(new Set(run.items.map((i) => i.transactionHash).filter(Boolean) as string[]));
  return (
    <Section title="On-chain record">
      <dl className="divide-y text-[0.8125rem]">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <dt className="text-muted-foreground">Escrow contract</dt>
          <dd>
            <Address value={contracts.escrow} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <dt className="text-muted-foreground">Run ID</dt>
          <dd className="num font-mono">{run.chainRunId ?? "Not on-chain yet"}</dd>
        </div>
        {(
          [
            ["Created", run.createTxHash],
            ["Funded", run.fundTxHash],
            ["Published", run.publishTxHash],
          ] as const
        ).map(([label, h]) => (
          <div key={label} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{h ? <TxLink hash={h} /> : <span className="text-muted-foreground">-</span>}</dd>
          </div>
        ))}
        {run.paymentsHash ? (
          <div className="grid gap-1 px-4 py-2.5">
            <dt className="text-muted-foreground">Payment list fingerprint</dt>
            <dd className="flex items-center gap-1 font-mono text-xs break-all">
              {run.paymentsHash}
              <CopyButton value={run.paymentsHash} />
            </dd>
          </div>
        ) : null}
        {itemTxs.length ? (
          <div className="grid gap-1.5 px-4 py-2.5">
            <dt className="text-muted-foreground">Other transactions ({itemTxs.length})</dt>
            <dd className="flex flex-wrap gap-x-3 gap-y-1">
              {itemTxs.slice(0, 12).map((h) => (
                <TxLink key={h} hash={h} />
              ))}
              {itemTxs.length > 12 ? <span className="text-muted-foreground">and {itemTxs.length - 12} more in the table</span> : null}
            </dd>
          </div>
        ) : null}
      </dl>
      <a href={explorerAddress(contracts.escrow)} target="_blank" rel="noreferrer" className="block border-t px-4 py-2.5 text-[0.8125rem] text-muted-foreground hover:text-foreground">
        All escrow activity on the explorer
      </a>
    </Section>
  );
}

function Approvals({ org, run }: { org: Organization; run: PayrollRunDetail }) {
  const members = useMembers(org.id);
  const byWallet = useMemo(() => new Map((members.data ?? []).map((m) => [m.walletAddress.toLowerCase(), m] as const)), [members.data]);
  const owner = org.ownerWallet.toLowerCase();
  const nameOf = (w: string) => (w.toLowerCase() === owner ? "Owner" : byWallet.get(w.toLowerCase())?.displayName || byWallet.get(w.toLowerCase())?.email || null);
  // Owner holds every role. Others count only while they still hold APPROVER (and the member list loaded).
  const stillApprover = (w: string): boolean | undefined => {
    if (w.toLowerCase() === owner) return true;
    if (!members.data) return undefined;
    const m: Member | undefined = byWallet.get(w.toLowerCase());
    return Boolean(m && m.status !== "removed" && has(m.roles, ROLE.APPROVER));
  };
  const valid = run.validApprovals;
  const required = run.approvalsRequired;
  const short = run.status === "approved" && valid !== null && required !== null && valid < required;

  return (
    <Section
      title="Approvals"
      actions={
        valid !== null && required !== null ? (
          <span className={cn("num text-[0.8125rem]", short ? "font-medium text-bad" : "text-muted-foreground")}>
            {valid} of {required} valid {required === 1 ? "approval" : "approvals"}
          </span>
        ) : null
      }
    >
      {short ? <p className="border-b bg-bad/[0.05] px-4 py-2.5 text-[0.8125rem] text-bad">{approvalsShortfall(valid, required)}</p> : null}
      {run.approvals.length === 0 ? (
        <p className="px-4 py-3 text-[0.8125rem] text-muted-foreground">No approvals yet.</p>
      ) : (
        <ul className="divide-y text-[0.8125rem]">
          {run.approvals.map((a, i) => {
            const name = nameOf(a.approverWallet);
            const holds = stillApprover(a.approverWallet);
            const revoked = a.status === "approved" && holds === false;
            return (
              <li key={i} className="px-4 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {name ? <p className="truncate font-medium">{name}</p> : null}
                    <Address value={a.approverWallet} />
                  </div>
                  <StatusDot
                    tone={a.status !== "approved" ? "bad" : revoked ? "warn" : "ok"}
                    label={a.status !== "approved" ? "Returned" : revoked ? "Doesn't count" : "Approved"}
                    className="text-[0.8125rem]"
                  />
                </div>
                {revoked ? <p className="mt-1 text-warn">No longer an approver, so this approval no longer counts.</p> : null}
                <p className="mt-0.5 text-muted-foreground">
                  {relativeTime(a.approvedAt)}
                  {a.txHash ? (
                    <>
                      {" · "}
                      <TxLink hash={a.txHash} />
                    </>
                  ) : null}
                </p>
                {a.rejectionReason ? <p className="mt-1">&ldquo;{a.rejectionReason}&rdquo;</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function ItemsTable({ run }: { run: PayrollRunDetail }) {
  const org = useOrg();
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [page, setPage] = useState(1);
  const tx = useRunTx(org.id, run.id);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: run.items.length };
    for (const i of run.items) c[i.claimStatus] = (c[i.claimStatus] ?? 0) + 1;
    return c;
  }, [run.items]);
  const rows = useMemo(() => (filter === "all" ? run.items : run.items.filter((i) => i.claimStatus === filter)).slice().sort((a, b) => a.index - b.index), [run.items, filter]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const view = rows.slice((Math.min(page, pages) - 1) * PAGE, Math.min(page, pages) * PAGE);
  const published = ["published", "partially_claimed", "completed", "expired"].includes(run.status);
  const withLinks = run.items.filter((i) => i.paymentId && i.claimStatus !== "cancelled").length;

  function claimLink(pid: string) {
    return `${window.location.origin}/claim/${pid}`;
  }

  function copyAll() {
    const text = claimLinksTsv(run, window.location.origin);
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success(`${withLinks.toLocaleString()} claim ${withLinks === 1 ? "link" : "links"} copied`, { description: published ? "Paste into a spreadsheet: name, wallet, amount, status, link." : "They work once the run is published." }))
      .catch(() => toast.error("Couldn't copy", { description: "Your browser blocked the clipboard." }));
  }

  // Filter words match the status words in the table for this run's state.
  const allocatedWord = itemStatus("allocated", run.status).label;
  const FILTERS: [ItemFilter, string][] = [
    ["all", "All"],
    ["claimed", "Claimed"],
    ["allocated", allocatedWord],
    ["pending", "Not on-chain yet"],
    ["cancelled", "Cancelled"],
    ["expired", "Expired"],
  ];

  function actions(i: PayrollItem) {
    if (!i.paymentId) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${i.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard?.writeText(claimLink(i.paymentId!));
              toast.success(published ? "Claim link copied" : "Claim link copied. It works once the run is published.");
            }}
          >
            <Link2 /> Copy claim link
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`/claim/${i.paymentId}`} target="_blank" rel="noreferrer">
              Open claim page
            </a>
          </DropdownMenuItem>
          {canCancelPayment(run, i, org.myRoles) ? (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                if (!confirm(`Remove the payment to ${i.name} from this draft? No MUSD has moved yet.`)) return;
                void tx.send("cancel_payment", build.cancelPayment(BigInt(i.paymentId!)), { successMessage: "Payment removed from the draft" });
              }}
            >
              Remove from draft
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <Section
      title="Recipients"
      actions={
        <div className="flex flex-wrap items-center gap-1 text-[0.8125rem]">
          {FILTERS.filter(([k]) => k === "all" || counts[k]).map(([k, l]) => (
            <button
              key={k}
              type="button"
              aria-pressed={filter === k}
              onClick={() => {
                setFilter(k);
                setPage(1);
              }}
              className={cn("num cursor-pointer rounded-md px-2 py-0.5", filter === k ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
            >
              {l} {counts[k] ?? 0}
            </button>
          ))}
        </div>
      }
    >
      {withLinks ? (
        <div className="flex flex-col gap-2 border-b px-4 py-2.5 text-[0.8125rem] sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground">Recipients get an email only if your organization has email set up. Otherwise, send each person their claim link.</p>
          <Button variant="outline" size="sm" className="shrink-0" onClick={copyAll}>
            <ClipboardList data-icon="inline-start" /> Copy all claim links
          </Button>
        </div>
      ) : null}
      <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} className="m-3" />

      {/* Small screens: one stacked row per person, name, amount and status always visible. */}
      <ul className="divide-y md:hidden">
        {view.map((i) => {
          const st = itemStatus(i.claimStatus, run.status);
          return (
            <li key={i.id} className="flex items-start gap-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate font-medium">{i.name}</p>
                  <Musd wei={i.amount} className="shrink-0 text-sm font-medium" />
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <StatusDot tone={st.tone} label={st.label} className="text-[0.8125rem]" />
                  <Address value={i.recipientAddress} />
                </div>
                {i.claimStatus === "claimed" ? (
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {i.claimedAt ? <span>Claimed {formatDate(i.claimedAt)}</span> : null}
                    {i.transactionHash ? <TxLink hash={i.transactionHash} className="text-xs" /> : null}
                  </p>
                ) : i.description || i.department ? (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{i.description || i.department}</p>
                ) : null}
              </div>
              <div className="-mr-2 shrink-0">{actions(i)}</div>
            </li>
          );
        })}
      </ul>

      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Recipient</TableHead>
              <TableHead>Wallet</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Claim tx</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.map((i) => {
              const st = itemStatus(i.claimStatus, run.status);
              return (
                <TableRow key={i.id}>
                  <TableCell className="max-w-56">
                    <p className="truncate font-medium">{i.name}</p>
                    <p className="truncate text-[0.8125rem] text-muted-foreground">{i.description || i.department || i.email || ""}</p>
                  </TableCell>
                  <TableCell>
                    <Address value={i.recipientAddress} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Musd wei={i.amount} />
                  </TableCell>
                  <TableCell>
                    <StatusDot tone={st.tone} label={st.label} />
                    {i.claimedAt ? <p className="text-xs text-muted-foreground">{formatDate(i.claimedAt)}</p> : null}
                  </TableCell>
                  <TableCell>{i.claimStatus === "claimed" && i.transactionHash ? <TxLink hash={i.transactionHash} /> : <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>{actions(i)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {pages > 1 ? (
        <div className="flex items-center justify-between border-t px-4 py-2.5 text-[0.8125rem]">
          <span className="num text-muted-foreground">
            Page {Math.min(page, pages)} of {pages}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
