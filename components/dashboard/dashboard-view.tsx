"use client";

import Link from "next/link";
import { Plus, Upload } from "lucide-react";
import { errorMessage } from "@/lib/client/api";
import { formatDate, relativeTime } from "@/lib/client/format";
import { canOperate } from "@/lib/client/roles";
import { useDashboard } from "@/hooks/use-api";
import { useOrg } from "@/components/org/org-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, Section } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/empty-state";
import { Musd } from "@/components/shared/money";
import { TxLink } from "@/components/shared/address";
import { VolumeChart } from "./volume-chart";
import { CompletionBar } from "./completion-bar";

export function DashboardView() {
  const org = useOrg();
  const q = useDashboard(org.id);
  const base = `/app/${org.slug}`;
  const operator = canOperate(org.myRoles);
  const d = q.data;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={org.description || undefined}
        actions={
          operator ? (
            <>
              <Button asChild variant="outline">
                <Link href={`${base}/recipients?import=1`}>
                  <Upload data-icon="inline-start" /> Import recipients
                </Link>
              </Button>
              <Button asChild>
                <Link href={`${base}/runs/new`}>
                  <Plus data-icon="inline-start" /> New payroll run
                </Link>
              </Button>
            </>
          ) : null
        }
      />

      {q.isError ? (
        <Section>
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        </Section>
      ) : (
        <div className="space-y-6">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-5">
            {[
              { label: "Total paid", value: d ? <Musd wei={d.totalPaidWei} /> : null, hint: "Claimed by recipients" },
              { label: "Outstanding", value: d ? <Musd wei={d.outstandingWei} /> : null, hint: "Funded, not yet claimed" },
              { label: "Refundable", value: d ? <Musd wei={d.refundableWei} /> : null, hint: "Can return to funder" },
              { label: "Recipients", value: d ? <span className="num">{d.recipientCount.toLocaleString()}</span> : null, hint: "In your directory" },
              { label: "Payroll runs", value: d ? <span className="num">{d.runCount.toLocaleString()}</span> : null, hint: "All time" },
            ].map((s) => (
              <div key={s.label} className="bg-background px-4 py-4 last:max-lg:col-span-2">
                <dt className="text-[0.8125rem] text-muted-foreground">{s.label}</dt>
                <dd className="mt-1 truncate text-lg font-semibold tracking-[-0.01em]">{s.value ?? <Skeleton className="h-6 w-24" />}</dd>
                <dd className="mt-0.5 text-xs text-muted-foreground">{s.hint}</dd>
              </div>
            ))}
          </dl>

          <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
            <Section title="Monthly volume" description="MUSD funded into runs and claimed by recipients">
              {d ? <VolumeChart data={d.monthlyVolume} /> : <Skeleton className="m-4 h-56" />}
            </Section>
            <Section title="Claim progress" description="Across all published runs">
              {d ? <CompletionBar data={d.claimCompletion} /> : <Skeleton className="m-4 h-32" />}
            </Section>
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
            <Section title="Recent activity">
              {!d ? (
                <div className="space-y-3 p-4">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-3/5" />
                </div>
              ) : d.recentActivity.length === 0 ? (
                <p className="px-4 py-8 text-sm text-muted-foreground">Nothing yet. Runs, approvals and claims will be listed here.</p>
              ) : (
                <ul className="divide-y">
                  {d.recentActivity.slice(0, 10).map((a) => (
                    <li key={a.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{a.title}</p>
                        {a.detail ? <p className="truncate text-[0.8125rem] text-muted-foreground">{a.detail}</p> : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-4 text-[0.8125rem]">
                        {a.amountWei ? <Musd wei={a.amountWei} /> : null}
                        {a.txHash ? <TxLink hash={a.txHash} label="Tx" /> : null}
                        <span className="w-24 text-right text-muted-foreground" title={formatDate(a.at, true)}>
                          {relativeTime(a.at)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Upcoming" actions={<Link href={`${base}/schedules`} className="text-[0.8125rem] text-muted-foreground hover:text-foreground">Schedules</Link>}>
              {!d ? (
                <div className="space-y-3 p-4">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : d.upcoming.length === 0 ? (
                <p className="px-4 py-8 text-sm text-muted-foreground">No scheduled or pending runs.</p>
              ) : (
                <ul className="divide-y">
                  {d.upcoming.slice(0, 6).map((u, i) => {
                    const inner = (
                      <>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{u.name}</p>
                          <p className="text-[0.8125rem] text-muted-foreground">{formatDate(u.date)}</p>
                        </div>
                        <Musd wei={u.amountWei} className="text-sm" />
                      </>
                    );
                    return (
                      <li key={`${u.runId ?? u.scheduleId ?? i}`}>
                        {u.runId ? (
                          <Link href={`${base}/runs/${u.runId}`} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/40">
                            {inner}
                          </Link>
                        ) : (
                          <div className="flex items-center gap-4 px-4 py-3">{inner}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
          </div>
        </div>
      )}
    </>
  );
}
