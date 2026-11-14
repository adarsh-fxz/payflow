"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { ReconciliationRow, ReportsSummary } from "@/lib/api-types";
import { downloadFromApi, errorMessage, isChainUnavailable } from "@/lib/client/api";
import { formatDate, plural } from "@/lib/client/format";
import { RUN_STATUS } from "@/lib/client/status";
import { cn } from "@/lib/client/utils";
import { useReconciliation, useReportsSummary } from "@/hooks/use-api";
import { useOrg } from "@/components/org/org-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader, Section } from "@/components/shared/page-header";
import { EmptyState, ErrorState } from "@/components/shared/empty-state";
import { StatusDot } from "@/components/shared/status-dot";
import { Musd } from "@/components/shared/money";
import { Address } from "@/components/shared/address";
import { ChainBanner, DataAge, useRpcDown } from "@/components/shared/chain-banner";
import { VolumeChart } from "@/components/dashboard/volume-chart";

const FIELDS = [
  ["fundedWei", "Funded"],
  ["claimedWei", "Claimed"],
  ["refundedWei", "Refunded"],
  ["outstandingWei", "Outstanding"],
] as const;

/* Same words as the run table: a payment is "Unclaimed" only once its run is open for claims. */
const EXPORTS = [
  ["", "All payments"],
  ["claimed", "Claimed"],
  ["allocated", "Not claimed yet"],
  ["cancelled", "Cancelled"],
  ["expired", "Expired"],
] as const;

const PREVIEW = 10;

export function ReportsView() {
  const org = useOrg();
  const recon = useReconciliation(org.id);
  const summary = useReportsSummary(org.id);
  const rpcDown = useRpcDown();
  const r = recon.data;
  const sm = summary.data;
  const base = `/app/${org.slug}`;
  const chainDown = rpcDown || isChainUnavailable(recon.error) || isChainUnavailable(summary.error);

  function download(path: string, filename: string, label: string) {
    downloadFromApi(path, filename).catch((e) => toast.error(`${label} download failed`, { description: errorMessage(e) }));
  }
  function exportPayments(status: string, label: string) {
    const qs = status ? `?status=${status}` : "";
    download(`/api/orgs/${org.id}/reports/payments.csv${qs}`, `${org.slug}-payments${status ? "-" + status : ""}.csv`, label);
  }

  return (
    <>
      <PageHeader
        title="Reports"
        description="Payroll totals, what's still owed, who was paid, and PayFlow's records checked against the escrow."
        actions={
          <Button
            variant="outline"
            disabled={recon.isFetching || summary.isFetching}
            onClick={() => {
              void recon.refetch();
              void summary.refetch();
            }}
          >
            <RefreshCw data-icon="inline-start" className={recon.isFetching || summary.isFetching ? "animate-spin" : undefined} /> Refresh
          </Button>
        }
      />

      <div className="space-y-6">
        {chainDown ? <ChainBanner hasData={Boolean(r || sm)} updatedAt={r?.generatedAt ?? sm?.generatedAt ?? null} /> : null}

        {/* ---------- payroll summary ---------- */}
        {summary.isError && !isChainUnavailable(summary.error) ? (
          <Section title="Payroll summary">
            <ErrorState message={errorMessage(summary.error)} onRetry={() => void summary.refetch()} />
          </Section>
        ) : summary.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : sm === null ? (
          <Section title="Payroll summary">
            <EmptyState title="Summary reports aren't available on this server yet" body="Reconciliation and CSV exports below still work." />
          </Section>
        ) : sm ? (
          <SummaryReports summary={sm} base={base} onDownloadRecipients={() => download(`/api/orgs/${org.id}/reports/recipients.csv`, `${org.slug}-recipients-report.csv`, "Recipient report")} />
        ) : null}

        {/* ---------- reconciliation ---------- */}
        {recon.isError && !isChainUnavailable(recon.error) ? (
          <Section>
            <ErrorState message={errorMessage(recon.error)} onRetry={() => void recon.refetch()} />
          </Section>
        ) : !r ? (
          recon.isLoading ? <Skeleton className="h-24 w-full" /> : null
        ) : (
          <div className={cn("flex flex-col gap-3 rounded-lg border px-4 py-4 sm:flex-row sm:items-center sm:justify-between", r.allMatch ? "" : "border-bad/40 bg-bad/[0.04]")}>
            <div>
              <StatusDot
                tone={r.allMatch ? "ok" : "bad"}
                label={r.allMatch ? "Every run matches the chain" : `${r.rows.filter((x) => !x.matches).length} ${r.rows.filter((x) => !x.matches).length === 1 ? "run doesn't" : "runs don't"} match the chain`}
                className="font-medium"
              />
              <p className="mt-1 text-[0.8125rem] text-muted-foreground">
                Checked {formatDate(r.generatedAt, true)}. {r.allMatch ? "" : "Open a mismatched run and press Sync to re-read it from the chain."}
                {(r as typeof r & { truncated?: boolean }).truncated ? " Only the most recent runs were checked; older runs aren't listed." : ""}
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-[0.8125rem]">
              <dt className="text-muted-foreground">Escrow holds for all orgs</dt>
              <dd className="text-right">
                <Musd wei={r.escrow.totalHeldWei} />
              </dd>
              <dt className="text-muted-foreground">Escrow MUSD balance</dt>
              <dd className="text-right">
                <Musd wei={r.escrow.balanceWei} />
              </dd>
              <dt className="text-muted-foreground">Contract</dt>
              <dd className="text-right">
                <Address value={r.escrow.address} />
              </dd>
            </dl>
          </div>
        )}

        <Section title="Reconciliation" description="Each figure shows PayFlow's record; a second line appears where the chain says something else.">
          {!r ? (
            recon.isLoading ? (
              <div className="space-y-3 p-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-5 w-full" />
                ))}
              </div>
            ) : (
              <EmptyState title="Can't check against the chain right now" body="Reconciliation reads the escrow live. Try again when Mezo is reachable." />
            )
          ) : r.rows.length === 0 ? (
            <EmptyState title="No runs on-chain yet" body="Runs appear here once they've been added to the escrow." />
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[720px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Run</TableHead>
                    <TableHead>Result</TableHead>
                    {FIELDS.map(([, l]) => (
                      <TableHead key={l} className="text-right">
                        {l}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Refundable</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.rows.map((row) => (
                    <ReconRow key={row.runId} row={row} href={`${base}/runs/${row.runId}`} />
                  ))}
                </TableBody>
                <tfoot className="border-t bg-surface text-sm font-medium">
                  <tr>
                    <td className="px-3 py-2.5" colSpan={2}>
                      Totals
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Musd wei={r.totals.fundedWei} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Musd wei={r.totals.claimedWei} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground">-</td>
                    <td className="px-3 py-2.5 text-right">
                      <Musd wei={r.totals.outstandingWei} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Musd wei={r.totals.refundableWei} />
                    </td>
                  </tr>
                </tfoot>
              </Table>
            </div>
          )}
        </Section>

        <Section title="Downloads" description="CSV files open in any spreadsheet. Cells that look like formulas are escaped.">
          <div className="grid gap-4 p-4 sm:grid-cols-[auto_1fr] sm:items-baseline">
            <p className="text-sm font-medium">Payments</p>
            <div className="flex flex-wrap gap-2">
              {EXPORTS.map(([st, l]) => (
                <Button key={l} variant="outline" size="sm" onClick={() => exportPayments(st, l)}>
                  <Download data-icon="inline-start" /> {l}
                </Button>
              ))}
            </div>
            <p className="text-sm font-medium">Recipients</p>
            <div>
              <Button variant="outline" size="sm" disabled={sm === null} onClick={() => download(`/api/orgs/${org.id}/reports/recipients.csv`, `${org.slug}-recipients-report.csv`, "Recipient report")}>
                <Download data-icon="inline-start" /> Paid and unclaimed per recipient
              </Button>
            </div>
          </div>
        </Section>
      </div>
    </>
  );
}

function SummaryReports({ summary: s, base, onDownloadRecipients }: { summary: ReportsSummary; base: string; onDownloadRecipients: () => void }) {
  const p = s.payroll;
  const stats: [string, ReactNode, string][] = [
    ["Funded", <Musd key="f" wei={p.fundedWei} />, `${plural(p.runs, "run")} in total`],
    ["Claimed", <Musd key="c" wei={p.claimedWei} />, `${plural(p.completedRuns, "run")} fully claimed`],
    ["Outstanding", <Musd key="o" wei={p.outstandingWei} />, `${plural(p.publishedRuns, "run")} open for claims`],
    ["Refunded", <Musd key="r" wei={p.refundedWei} />, "Back to the funding wallets"],
  ];
  return (
    <>
      <section aria-labelledby="sum-h">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="sum-h" className="text-sm font-semibold">
            Payroll summary
          </h2>
          <DataAge at={s.generatedAt} className="text-xs text-muted-foreground" />
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
          {stats.map(([label, value, hint]) => (
            <div key={label} className="bg-background px-4 py-3.5">
              <dt className="text-[0.8125rem] text-muted-foreground">{label}</dt>
              <dd className="mt-1 truncate text-base font-semibold">{value}</dd>
              <dd className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <Section title="Monthly volume" description="MUSD funded into the escrow and claimed by recipients, by month.">
          <VolumeChart data={s.monthlyVolume} />
        </Section>
        <Section title="Outstanding by run" description="Published runs with money still waiting to be claimed.">
          {s.outstandingByRun.length === 0 ? (
            <EmptyState title="Nothing outstanding" body="Every published payment has been claimed, expired or refunded." />
          ) : (
            <ul className="divide-y text-sm">
              {s.outstandingByRun.map((o) => (
                <li key={o.runId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0">
                    <Link href={`${base}/runs/${o.runId}`} className="block truncate font-medium hover:underline">
                      {o.name}
                    </Link>
                    <span className="text-xs text-muted-foreground">{o.claimDeadline ? `Claims close ${formatDate(o.claimDeadline)}` : "No deadline yet"}</span>
                  </span>
                  <Musd wei={o.outstandingWei} className="shrink-0" />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Unclaimed payments" description="Published payments nobody has claimed yet. Send these people their claim link.">
        <Expandable
          rows={s.unclaimed}
          empty={<EmptyState title="No unclaimed payments" body="Everyone in an open run has claimed." />}
          head={
            <TableRow className="hover:bg-transparent">
              <TableHead>Recipient</TableHead>
              <TableHead>Run</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Claim by</TableHead>
            </TableRow>
          }
          row={(u) => (
            <TableRow key={u.paymentId}>
              <TableCell className="max-w-56">
                <p className="truncate font-medium">{u.name}</p>
                <Address value={u.recipientAddress} />
              </TableCell>
              <TableCell className="max-w-48">
                <Link href={`${base}/runs/${u.runId}`} className="block truncate hover:underline">
                  {u.runName}
                </Link>
              </TableCell>
              <TableCell className="text-right">
                <Musd wei={u.amountWei} />
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDate(u.claimDeadline) || "-"}</TableCell>
            </TableRow>
          )}
        />
      </Section>

      <Section title="Completed runs" description="Runs where every payment was claimed.">
        <Expandable
          rows={s.completedRuns}
          empty={<EmptyState title="No completed runs yet" body="A run is complete once every recipient has claimed." />}
          head={
            <TableRow className="hover:bg-transparent">
              <TableHead>Run</TableHead>
              <TableHead>Completed</TableHead>
              <TableHead className="text-right">Recipients</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          }
          row={(c) => (
            <TableRow key={c.runId}>
              <TableCell className="max-w-64">
                <Link href={`${base}/runs/${c.runId}`} className="block truncate font-medium hover:underline">
                  {c.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDate(c.completedAt) || "-"}</TableCell>
              <TableCell className="num text-right">{c.recipientCount.toLocaleString()}</TableCell>
              <TableCell className="text-right">
                <Musd wei={c.totalWei} />
              </TableCell>
            </TableRow>
          )}
        />
      </Section>

      <Section
        title="Per recipient"
        description="Everything each wallet has been paid, and what's still waiting for them."
        actions={
          <Button variant="outline" size="sm" onClick={onDownloadRecipients}>
            <Download data-icon="inline-start" /> CSV
          </Button>
        }
      >
        <Expandable
          rows={s.recipients}
          empty={<EmptyState title="No payments yet" body="Recipients show here after their first published payment." />}
          head={
            <TableRow className="hover:bg-transparent">
              <TableHead>Recipient</TableHead>
              <TableHead className="text-right">Payments</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Unclaimed</TableHead>
              <TableHead>Last paid</TableHead>
            </TableRow>
          }
          row={(x) => (
            <TableRow key={x.recipientAddress}>
              <TableCell className="max-w-56">
                <p className="truncate font-medium">{x.name}</p>
                <Address value={x.recipientAddress} />
              </TableCell>
              <TableCell className="num text-right">{x.paymentCount.toLocaleString()}</TableCell>
              <TableCell className="text-right">
                <Musd wei={x.paidWei} />
              </TableCell>
              <TableCell className="text-right">
                <Musd wei={x.unclaimedWei} className={BigInt(x.unclaimedWei || "0") > 0n ? undefined : "text-muted-foreground"} />
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDate(x.lastPaidAt) || "-"}</TableCell>
            </TableRow>
          )}
        />
      </Section>
    </>
  );
}

/** A table that shows the first rows and expands on request. */
function Expandable<T>({ rows, head, row, empty }: { rows: T[]; head: ReactNode; row: (r: T) => ReactNode; empty: ReactNode }) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return <>{empty}</>;
  const shown = all ? rows : rows.slice(0, PREVIEW);
  return (
    <>
      <div className="overflow-x-auto">
        <Table className="min-w-[560px]">
          <TableHeader>{head}</TableHeader>
          <TableBody>{shown.map(row)}</TableBody>
        </Table>
      </div>
      {rows.length > PREVIEW ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="block w-full cursor-pointer border-t px-4 py-2.5 text-left text-[0.8125rem] text-muted-foreground hover:text-foreground">
          {all ? "Show fewer" : `Show all ${rows.length.toLocaleString()}`}
        </button>
      ) : null}
    </>
  );
}

function ReconRow({ row, href }: { row: ReconciliationRow; href: string }) {
  const s = RUN_STATUS[row.status];
  return (
    <TableRow className={row.matches ? undefined : "bg-bad/[0.035]"}>
      <TableCell className="max-w-56">
        <Link href={href} className="block truncate font-medium hover:underline">
          {row.name}
        </Link>
        <span className="text-[0.8125rem] text-muted-foreground">
          {s.label}
          {row.chainRunId ? ` · run ${row.chainRunId}` : ""}
        </span>
      </TableCell>
      <TableCell>{row.chain === null ? <StatusDot tone="idle" label="Not on-chain" /> : <StatusDot tone={row.matches ? "ok" : "bad"} label={row.matches ? "Match" : "Mismatch"} />}</TableCell>
      {FIELDS.map(([k]) => {
        const db = row.db[k];
        const ch = row.chain?.[k];
        const differs = ch !== undefined && ch !== db;
        return (
          <TableCell key={k} className="text-right align-top">
            <Musd wei={db} unit={false} className={differs ? "text-bad" : undefined} />
            {differs ? (
              <p className="num text-xs text-muted-foreground">
                chain <Musd wei={ch} unit={false} />
              </p>
            ) : null}
          </TableCell>
        );
      })}
      <TableCell className="text-right">{row.chain ? <Musd wei={row.chain.refundableWei} unit={false} /> : <span className="text-muted-foreground">-</span>}</TableCell>
    </TableRow>
  );
}
