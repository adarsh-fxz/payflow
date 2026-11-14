"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import type { PayrollRun, RunStatus } from "@/lib/api-types";
import { errorMessage } from "@/lib/client/api";
import { CATEGORY_LABEL, formatDate } from "@/lib/client/format";
import { canOperate } from "@/lib/client/roles";
import { RUN_STATUS } from "@/lib/client/status";
import { cn } from "@/lib/client/utils";
import { useRuns } from "@/hooks/use-api";
import { useOrg } from "@/components/org/org-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader, Section } from "@/components/shared/page-header";
import { EmptyState, ErrorState } from "@/components/shared/empty-state";
import { StatusDot } from "@/components/shared/status-dot";
import { Musd } from "@/components/shared/money";

const GROUPS: { key: string; label: string; statuses: RunStatus[] | null }[] = [
  { key: "all", label: "All", statuses: null },
  { key: "action", label: "In progress", statuses: ["draft", "onchain_draft", "pending_approval", "approved", "funded"] },
  { key: "open", label: "Open for claims", statuses: ["published", "partially_claimed"] },
  { key: "closed", label: "Closed", statuses: ["completed", "cancelled", "expired"] },
];

export function RunsList() {
  const org = useOrg();
  const router = useRouter();
  const runs = useRuns(org.id);
  const [group, setGroup] = useState("all");
  const list = useMemo(() => {
    const g = GROUPS.find((x) => x.key === group);
    const all = [...(runs.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return g?.statuses ? all.filter((r) => g.statuses!.includes(r.status)) : all;
  }, [runs.data, group]);
  const base = `/app/${org.slug}`;

  return (
    <>
      <PageHeader
        title="Payroll runs"
        description="Each run is one batch of payments with its own escrow balance."
        actions={
          canOperate(org.myRoles) ? (
            <Button asChild>
              <Link href={`${base}/runs/new`}>
                <Plus data-icon="inline-start" /> New payroll run
              </Link>
            </Button>
          ) : null
        }
      />
      <Section>
        <div className="flex gap-1 overflow-x-auto border-b px-3 py-2 text-sm">
          {GROUPS.map((g) => {
            const n = g.statuses ? (runs.data ?? []).filter((r) => g.statuses!.includes(r.status)).length : (runs.data ?? []).length;
            return (
              <button
                key={g.key}
                type="button"
                aria-pressed={group === g.key}
                onClick={() => setGroup(g.key)}
                className={cn("num shrink-0 cursor-pointer rounded-md px-2.5 py-1", group === g.key ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
              >
                {g.label} <span className="text-muted-foreground">{runs.data ? n : ""}</span>
              </button>
            );
          })}
        </div>
        {runs.isError ? (
          <ErrorState message={errorMessage(runs.error)} onRetry={() => void runs.refetch()} />
        ) : runs.isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : list.length === 0 ? (
          (runs.data ?? []).length === 0 ? (
            <EmptyState
              title="No payroll runs yet"
              body="Start a run, upload a CSV or pick recipients, and PayFlow checks every row before anything goes on-chain."
              action={
                canOperate(org.myRoles) ? (
                  <Button asChild>
                    <Link href={`${base}/runs/new`}>New payroll run</Link>
                  </Button>
                ) : null
              }
            />
          ) : (
            <EmptyState title="No runs in this view" />
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Recipients</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="hidden text-right md:table-cell">Claimed</TableHead>
                <TableHead className="hidden lg:table-cell">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <RunRow key={r.id} run={r} onOpen={() => router.push(`${base}/runs/${r.id}`)} href={`${base}/runs/${r.id}`} />
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </>
  );
}

function RunRow({ run, href, onOpen }: { run: PayrollRun; href: string; onOpen: () => void }) {
  const s = RUN_STATUS[run.status];
  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell className="max-w-72">
        <Link href={href} onClick={(e) => e.stopPropagation()} className="block truncate font-medium hover:underline">
          {run.name}
        </Link>
        <span className="text-[0.8125rem] text-muted-foreground">{CATEGORY_LABEL[run.paymentCategory]}</span>
      </TableCell>
      <TableCell>
        <StatusDot tone={s.tone} label={s.label} />
      </TableCell>
      <TableCell className="num text-right">{run.recipientCount.toLocaleString()}</TableCell>
      <TableCell className="text-right">
        <Musd wei={run.totalAmount} />
      </TableCell>
      <TableCell className="num hidden text-right text-muted-foreground md:table-cell">
        {["published", "partially_claimed", "completed", "expired"].includes(run.status) ? `${run.claimedCount.toLocaleString()} of ${run.recipientCount.toLocaleString()}` : "-"}
      </TableCell>
      <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDate(run.createdAt)}</TableCell>
    </TableRow>
  );
}
