"use client";

import { memo, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { formatMusd } from "@/lib/money";
import { cn } from "@/lib/client/utils";
import { blockingFileIssues, summaryParts, type DraftRow, type RowCheck, type WizardValidation } from "@/lib/client/wizard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { IssueList } from "@/components/csv/issue-list";

const PAGE = 50;
type Filter = "attention" | "all" | "excluded";

export function StepCheck({
  rows,
  validation,
  stale,
  setRows,
  setExcluded,
  balanceWei,
}: {
  rows: DraftRow[];
  validation: WizardValidation | undefined;
  stale: boolean;
  setRows: (fn: (r: DraftRow[]) => DraftRow[]) => void;
  setExcluded: (fn: (ex: Set<string>) => Set<string>) => void;
  balanceWei?: string;
}) {
  const hasErrors = (validation?.blockingCount ?? 0) > 0;
  const [filter, setFilter] = useState<Filter>(hasErrors ? "attention" : "all");
  const [page, setPage] = useState(1);
  // Rows stay in "Needs attention" while being fixed, so they don't vanish mid-edit.
  const needsAttention = (c: RowCheck) => !c.excluded && (!c.valid || c.issues.length > 0);
  const [pinned, setPinned] = useState<Set<string>>(() => new Set((validation?.checks ?? []).filter(needsAttention).map((c) => c.row.key)));

  const checks = useMemo(() => validation?.checks ?? [], [validation]);
  const shown = useMemo(() => {
    if (filter === "attention") return checks.filter((c) => pinned.has(c.row.key) || needsAttention(c));
    if (filter === "excluded") return checks.filter((c) => c.excluded);
    return checks;
    }, [checks, filter, pinned]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const pageRows = shown.slice((Math.min(page, pages) - 1) * PAGE, Math.min(page, pages) * PAGE);
  const rowNumber = useMemo(() => new Map(rows.map((r, i) => [r.key, i + 1])), [rows]);

  if (!validation) return <Skeleton className="h-64 w-full" />;
  const fileIssues = blockingFileIssues(validation);
  const invalidKeys = checks.filter((c) => !c.excluded && !c.valid).map((c) => c.row.key);
  const balanceShort = validation.report.balanceCheck && !validation.report.balanceCheck.sufficient;

  function update(key: string, patch: Partial<DraftRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-lg border bg-surface px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <p className={cn("num text-sm", stale && "opacity-60")} aria-live="polite">
          {summaryParts(validation).join(" · ")}
          <span className="text-muted-foreground"> · total </span>
          <span className="font-semibold">{formatMusd(validation.report.totalPayableWei)} MUSD</span>
        </p>
        {invalidKeys.length ? (
          <Button variant="outline" size="sm" onClick={() => setExcluded((ex) => new Set([...ex, ...invalidKeys]))}>
            Exclude {invalidKeys.length} {invalidKeys.length === 1 ? "row" : "rows"} with errors
          </Button>
        ) : (
          <p className="text-sm text-ok">Every included row is valid.</p>
        )}
      </div>

      {fileIssues.length ? <IssueList issues={fileIssues} /> : null}
      {balanceShort ? (
        <p className="rounded-md border border-warn/50 bg-warn/[0.06] px-3 py-2 text-sm">
          Your connected wallet holds {formatMusd(balanceWei ?? "0")} MUSD, less than this run&apos;s total. You can still save the draft; the funding wallet needs enough MUSD later.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1 text-sm">
        {(
          [
            ["attention", `Needs attention (${checks.filter(needsAttention).length})`],
            ["all", `All (${checks.length})`],
            ["excluded", `Excluded (${validation.excludedCount})`],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            aria-pressed={filter === k}
            onClick={() => {
              setFilter(k);
              setPage(1);
              if (k === "attention") setPinned(new Set(checks.filter(needsAttention).map((c) => c.row.key)));
            }}
            className={cn("num cursor-pointer rounded-md px-2.5 py-1", filter === k ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Small screens: one card per row, every field stacked and editable. */}
      <ul className="space-y-3 md:hidden">
        {pageRows.length === 0 ? (
          <li className="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">
            {filter === "attention" ? "Nothing needs attention." : filter === "excluded" ? "No excluded rows." : "No rows."}
          </li>
        ) : (
          pageRows.map((c) => (
            <CheckCard
              key={c.row.key}
              check={c}
              n={rowNumber.get(c.row.key) ?? 0}
              onChange={update}
              onToggle={(include) =>
                setExcluded((ex) => {
                  if (include) ex.delete(c.row.key);
                  else ex.add(c.row.key);
                  return ex;
                })
              }
              onRemove={() => setRows((rs) => rs.filter((r) => r.key !== c.row.key))}
            />
          ))
        )}
      </ul>

      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <table className="w-full min-w-[960px] text-sm">
          <thead className="bg-surface text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2 font-medium">
                <span className="sr-only">Include</span>
              </th>
              <th className="w-12 px-2 py-2 font-medium">Row</th>
              <th className="px-2 py-2 font-medium">Name</th>
              <th className="w-[15.5rem] px-2 py-2 font-medium">Wallet address</th>
              <th className="w-32 px-2 py-2 font-medium">Amount (MUSD)</th>
              <th className="px-2 py-2 font-medium">Email</th>
              <th className="px-2 py-2 font-medium">Note</th>
              <th className="w-10 px-2 py-2">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {filter === "attention" ? "Nothing needs attention." : filter === "excluded" ? "No excluded rows." : "No rows."}
                </td>
              </tr>
            ) : (
              pageRows.map((c) => (
                <CheckRow
                  key={c.row.key}
                  check={c}
                  n={rowNumber.get(c.row.key) ?? 0}
                  onChange={update}
                  onToggle={(include) =>
                    setExcluded((ex) => {
                      if (include) ex.delete(c.row.key);
                      else ex.add(c.row.key);
                      return ex;
                    })
                  }
                  onRemove={() => setRows((rs) => rs.filter((r) => r.key !== c.row.key))}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <div className="flex items-center justify-between text-[0.8125rem]">
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
      <p className="text-[0.8125rem] text-muted-foreground">Edit any cell to fix it. Excluded rows stay listed here and are left out of the run.</p>
    </div>
  );
}

const cellInput =
  "h-8 w-full rounded-md border border-transparent bg-transparent px-2 outline-none transition-colors hover:border-input focus:border-ring focus:bg-background focus:ring-3 focus:ring-ring/40 aria-invalid:border-bad/60 aria-invalid:bg-bad/[0.04] disabled:opacity-60";

const CheckRow = memo(function CheckRow({
  check,
  n,
  onChange,
  onToggle,
  onRemove,
}: {
  check: RowCheck;
  n: number;
  onChange: (key: string, p: Partial<DraftRow>) => void;
  onToggle: (include: boolean) => void;
  onRemove: () => void;
}) {
  const { row, excluded, valid, issues } = check;
  const bad = (col: string) => issues.some((i) => i.severity === "error" && (i.column === col || (col === "wallet_address" && i.code === "duplicate_row")));
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return (
    <>
      <tr className={cn("border-t align-top", excluded ? "bg-muted/40 text-muted-foreground" : !valid && "bg-bad/[0.035]")}>
        <td className="px-3 py-2">
          <Checkbox checked={!excluded} onCheckedChange={(v) => onToggle(Boolean(v))} aria-label={excluded ? `Include row ${n}` : `Exclude row ${n}`} className="mt-2" />
        </td>
        <td className="num px-2 py-2 pt-3.5 text-muted-foreground">{n}</td>
        <td className="px-2 py-1.5">
          <input className={cellInput} value={row.name} disabled={excluded} aria-label={`Row ${n} name`} aria-invalid={bad("name")} onChange={(e) => onChange(row.key, { name: e.target.value })} />
        </td>
        <td className="px-2 py-1.5">
          <WalletInput value={row.walletAddress} disabled={excluded} n={n} invalid={bad("wallet_address")} onChange={(v) => onChange(row.key, { walletAddress: v })} />
        </td>
        <td className="px-2 py-1.5">
          <input
            className={cn(cellInput, "num text-right")}
            value={row.amount}
            inputMode="decimal"
            disabled={excluded}
            aria-label={`Row ${n} amount`}
            aria-invalid={bad("amount")}
            onChange={(e) => onChange(row.key, { amount: e.target.value })}
          />
        </td>
        <td className="px-2 py-1.5">
          <input className={cellInput} value={row.email} type="email" disabled={excluded} aria-label={`Row ${n} email`} aria-invalid={bad("email")} onChange={(e) => onChange(row.key, { email: e.target.value })} />
        </td>
        <td className="px-2 py-1.5">
          <input className={cellInput} value={row.description} disabled={excluded} aria-label={`Row ${n} note`} aria-invalid={bad("description")} onChange={(e) => onChange(row.key, { description: e.target.value })} />
        </td>
        <td className="px-2 py-2">
          <button type="button" onClick={onRemove} aria-label={`Remove row ${n}`} className="mt-0.5 cursor-pointer rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <Trash2 className="size-3.5" />
          </button>
        </td>
      </tr>
      {!excluded && (errors.length || warnings.length) ? (
        <tr className={cn(!valid && "bg-bad/[0.035]")}>
          <td />
          <td />
          <td colSpan={6} className="px-4 pb-2.5 text-[0.8125rem]">
            {errors.map((i, k) => (
              <span key={k} className="mr-3 inline-block text-bad">
                {i.message}.
              </span>
            ))}
            {warnings.map((i, k) => (
              <span key={`w${k}`} className="mr-3 inline-block text-muted-foreground">
                {i.message}.
              </span>
            ))}
          </td>
        </tr>
      ) : null}
    </>
  );
});

/** Shows the start and the end of an address when not being edited, the full value while focused. */
function middle(v: string): string {
  return v.length > 22 ? `${v.slice(0, 10)}…${v.slice(-8)}` : v;
}

function WalletInput({ value, disabled, n, invalid, onChange, className }: { value: string; disabled: boolean; n: number; invalid: boolean; onChange: (v: string) => void; className?: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      className={cn(cellInput, "font-mono text-[0.8125rem]", className)}
      value={focused ? value : middle(value)}
      title={value}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      aria-label={`Row ${n} wallet address`}
      aria-invalid={invalid}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const CheckCard = memo(function CheckCard({
  check,
  n,
  onChange,
  onToggle,
  onRemove,
}: {
  check: RowCheck;
  n: number;
  onChange: (key: string, p: Partial<DraftRow>) => void;
  onToggle: (include: boolean) => void;
  onRemove: () => void;
}) {
  const { row, excluded, valid, issues } = check;
  const bad = (col: string) => issues.some((i) => i.severity === "error" && (i.column === col || (col === "wallet_address" && i.code === "duplicate_row")));
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const field = "grid gap-0.5 text-xs text-muted-foreground";
  const box = cn(cellInput, "h-9 border-input bg-background text-sm text-foreground");
  return (
    <li className={cn("rounded-lg border p-3", excluded ? "bg-muted/40 text-muted-foreground" : !valid && "border-bad/40 bg-bad/[0.035]")}>
      <div className="flex items-center gap-2">
        <Checkbox checked={!excluded} onCheckedChange={(v) => onToggle(Boolean(v))} aria-label={excluded ? `Include row ${n}` : `Exclude row ${n}`} />
        <span className="num text-sm text-muted-foreground">Row {n}</span>
        {excluded ? <span className="text-xs">Excluded</span> : null}
        <button type="button" onClick={onRemove} aria-label={`Remove row ${n}`} className="ml-auto cursor-pointer rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="mt-2 grid gap-2">
        <label className={field}>
          Name
          <input className={box} value={row.name} disabled={excluded} aria-invalid={bad("name")} onChange={(e) => onChange(row.key, { name: e.target.value })} />
        </label>
        <label className={field}>
          Wallet address
          <WalletInput value={row.walletAddress} disabled={excluded} n={n} invalid={bad("wallet_address")} onChange={(v) => onChange(row.key, { walletAddress: v })} className="h-9 border-input bg-background text-foreground" />
        </label>
        <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-2">
          <label className={field}>
            Amount (MUSD)
            <input className={cn(box, "num text-right")} inputMode="decimal" value={row.amount} disabled={excluded} aria-invalid={bad("amount")} onChange={(e) => onChange(row.key, { amount: e.target.value })} />
          </label>
          <label className={field}>
            Email
            <input className={box} type="email" value={row.email} disabled={excluded} aria-invalid={bad("email")} onChange={(e) => onChange(row.key, { email: e.target.value })} />
          </label>
        </div>
        <label className={field}>
          Note
          <input className={box} value={row.description} disabled={excluded} aria-invalid={bad("description")} onChange={(e) => onChange(row.key, { description: e.target.value })} />
        </label>
      </div>
      {!excluded && (errors.length || warnings.length) ? (
        <ul className="mt-2 space-y-0.5 text-[0.8125rem]">
          {errors.map((i, k) => (
            <li key={k} className="text-bad">
              {i.message}.
            </li>
          ))}
          {warnings.map((i, k) => (
            <li key={`w${k}`} className="text-muted-foreground">
              {i.message}.
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
});
