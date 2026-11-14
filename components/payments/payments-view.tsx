"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Hash } from "viem";
import type { RecipientPayment } from "@/lib/api-types";
import { ESCROW_LIMITS, isDeployed } from "@/lib/chain/config";
import { errorMessage, postUntilMined } from "@/lib/client/api";
import { formatDate } from "@/lib/client/format";
import { RECIPIENT_PAYMENT_STATUS } from "@/lib/client/status";
import { cn } from "@/lib/client/utils";
import { build } from "@/lib/client/writes";
import { useMyPayments } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useTx } from "@/hooks/use-tx";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Section } from "@/components/shared/page-header";
import { EmptyState, ErrorState } from "@/components/shared/empty-state";
import { StatusDot } from "@/components/shared/status-dot";
import { Musd } from "@/components/shared/money";
import { TxLink } from "@/components/shared/address";
import { TxStatus } from "@/components/shared/tx-status";
import { OrgAvatar } from "@/components/org/org-picker";

type F = "all" | RecipientPayment["status"];

export function PaymentsView() {
  const auth = useAuth();
  const q = useMyPayments(auth.signedIn);
  const tx = useTx();
  const [filter, setFilter] = useState<F>("all");
  const d = q.data;
  const available = useMemo(() => (d?.payments ?? []).filter((p) => p.status === "available"), [d]);
  const claimedWei = useMemo(() => (d?.payments ?? []).filter((p) => p.status === "claimed").reduce((n, p) => n + BigInt(p.amount), 0n), [d]);
  const list = useMemo(() => (d?.payments ?? []).filter((p) => filter === "all" || p.status === filter), [d, filter]);

  async function claimAll() {
    const batch = available.slice(0, ESCROW_LIMITS.MAX_CLAIM_BATCH);
    const ids = batch.map((p) => BigInt(p.paymentId));
    await tx.run(available.length === 1 ? build.claim(ids[0]) : build.claimMany(ids), {
      record: async (hash: Hash) => {
        for (const p of batch) await postUntilMined(`/api/claims/${p.paymentId}/confirm`, { txHash: hash });
      },
      successMessage: `${batch.length} ${batch.length === 1 ? "payment" : "payments"} claimed`,
      progress: available.length > ESCROW_LIMITS.MAX_CLAIM_BATCH ? `First ${ESCROW_LIMITS.MAX_CLAIM_BATCH} of ${available.length}` : undefined,
    });
    void q.refetch();
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">My payments</h1>
          <p className="mt-1 text-sm text-muted-foreground">Payments sent to your wallet through PayFlow, from every organization.</p>
        </div>
        {available.length > 1 && isDeployed ? (
          <Button onClick={() => void claimAll()} disabled={tx.isBusy || !auth.wallet.isReady}>
            {tx.isBusy ? "Claiming…" : `Claim all ${Math.min(available.length, ESCROW_LIMITS.MAX_CLAIM_BATCH)}`}
          </Button>
        ) : null}
      </div>

      <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} className="mt-4" />

      <dl className="mt-6 grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        {[
          ["Ready to claim", d ? <Musd key="a" wei={d.availableWei} /> : null, `${available.length} ${available.length === 1 ? "payment" : "payments"}`],
          ["Claimed", d ? <Musd key="c" wei={claimedWei} /> : null, "Already in your wallet"],
          ["Total received", d ? <Musd key="t" wei={d.totalReceivedWei} /> : null, "All time"],
        ].map(([l, v, h]) => (
          <div key={String(l)} className="bg-background px-4 py-4">
            <dt className="text-[0.8125rem] text-muted-foreground">{l}</dt>
            <dd className="mt-1 text-xl font-semibold tracking-[-0.01em]">{v ?? <Skeleton className="h-7 w-28" />}</dd>
            <dd className="mt-0.5 text-xs text-muted-foreground">{h}</dd>
          </div>
        ))}
      </dl>

      <Section className="mt-6" title="History" actions={
        <div className="flex flex-wrap gap-1 text-[0.8125rem]">
          {(["all", "available", "upcoming", "claimed", "expired", "cancelled"] as F[]).map((k) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={cn("cursor-pointer rounded-md px-2 py-0.5", filter === k ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              {k === "all" ? "All" : RECIPIENT_PAYMENT_STATUS[k].label}
            </button>
          ))}
        </div>
      }>
        {q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : q.isLoading ? (
          <div className="space-y-3 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}</div>
        ) : list.length === 0 ? (
          <EmptyState title={(d?.payments.length ?? 0) === 0 ? "No payments to this wallet yet" : "Nothing in this view"} body={(d?.payments.length ?? 0) === 0 ? "When an organization pays this wallet through PayFlow, it shows up here. Got a claim link? Open it directly." : undefined} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>From</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Date</TableHead>
                <TableHead>
                  <span className="sr-only">Action</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((p) => {
                const s = RECIPIENT_PAYMENT_STATUS[p.status];
                return (
                  <TableRow key={p.paymentId}>
                    <TableCell className="max-w-64">
                      <div className="flex items-center gap-3">
                        <OrgAvatar name={p.organization.name} logoUrl={p.organization.logoUrl} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{p.organization.name}</p>
                          <p className="truncate text-[0.8125rem] text-muted-foreground">{p.description || p.runName}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right"><Musd wei={p.amount} /></TableCell>
                    <TableCell><StatusDot tone={s.tone} label={s.label} /></TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {p.claimedAt ? formatDate(p.claimedAt) : p.claimDeadline && p.status === "available" ? `Claim by ${formatDate(p.claimDeadline)}` : ""}
                    </TableCell>
                    <TableCell className="text-right">
                      {p.status === "claimed" && p.transactionHash ? (
                        <TxLink hash={p.transactionHash} />
                      ) : p.status === "available" ? (
                        <Button asChild size="sm" variant="outline"><Link href={`/claim/${p.paymentId}`}>Claim</Link></Button>
                      ) : (
                        <Link href={`/claim/${p.paymentId}`} className="text-[0.8125rem] text-muted-foreground hover:text-foreground">Details</Link>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}
