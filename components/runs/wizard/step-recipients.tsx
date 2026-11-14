"use client";

import { useMemo, useState } from "react";
import { Download, Search, X } from "lucide-react";
import type { CsvIssue } from "@/lib/api-types";
import { PAYROLL_CSV_TEMPLATE } from "@/lib/csv/validate";
import { weiToDecimalString } from "@/lib/money";
import { saveText } from "@/lib/client/api";
import { shortAddress } from "@/lib/client/format";
import { cn } from "@/lib/client/utils";
import { newRow, rowsFromCsvText, type DraftRow } from "@/lib/client/wizard";
import { useRecipients } from "@/hooks/use-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { CsvDropZone } from "@/components/csv/drop-zone";
import { IssueList } from "@/components/csv/issue-list";

type Method = "csv" | "saved" | "manual";

export function StepRecipients({ orgId, rows, setRows }: { orgId: string; rows: DraftRow[]; setRows: (fn: (r: DraftRow[]) => DraftRow[]) => void }) {
  const [method, setMethod] = useState<Method>("csv");
  return (
    <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr]">
      <div className="min-w-0">
        <div role="tablist" aria-label="Add recipients" className="inline-flex rounded-md border p-0.5">
          {(
            [
              ["csv", "Upload CSV"],
              ["saved", "Saved recipients"],
              ["manual", "Add manually"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              role="tab"
              type="button"
              aria-selected={method === k}
              onClick={() => setMethod(k)}
              className={cn("cursor-pointer rounded px-3 py-1 text-sm", method === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="mt-5">
          {method === "csv" ? <CsvMethod setRows={setRows} /> : method === "saved" ? <SavedMethod orgId={orgId} rows={rows} setRows={setRows} /> : <ManualMethod setRows={setRows} />}
        </div>
      </div>
      <RowList rows={rows} setRows={setRows} />
    </div>
  );
}

function CsvMethod({ setRows }: { setRows: (fn: (r: DraftRow[]) => DraftRow[]) => void }) {
  const [result, setResult] = useState<{ name: string; added: number; fileErrors: CsvIssue[]; warnings: CsvIssue[] } | null>(null);
  return (
    <div className="space-y-3">
      <CsvDropZone
        onText={(text, name) => {
          const r = rowsFromCsvText(text);
          if (r.rows.length) setRows((prev) => [...prev, ...r.rows]);
          setResult({ name, added: r.rows.length, fileErrors: r.fileErrors, warnings: r.fileWarnings });
        }}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="outline" size="sm" onClick={() => saveText(PAYROLL_CSV_TEMPLATE, "payflow-payroll-template.csv")}>
          <Download data-icon="inline-start" /> Download template
        </Button>
        <p className="text-[0.8125rem] text-muted-foreground">Columns: name, wallet_address, amount (required), email, description, department.</p>
      </div>
      {result ? (
        <div role="status" className={cn("rounded-md border px-3 py-2.5 text-sm", result.fileErrors.length ? "border-bad/40 bg-bad/5" : "bg-surface")}>
          {result.fileErrors.length ? (
            <>
              <p className="font-medium">{result.name} could not be read</p>
              <IssueList issues={result.fileErrors} className="mt-1" />
            </>
          ) : (
            <>
              <p>
                Added <span className="num font-medium">{result.added}</span> {result.added === 1 ? "row" : "rows"} from {result.name}. Every row is checked in the next step, including ones with problems.
              </p>
              <IssueList issues={result.warnings} className="mt-1" />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SavedMethod({ orgId, rows, setRows }: { orgId: string; rows: DraftRow[]; setRows: (fn: (r: DraftRow[]) => DraftRow[]) => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const list = useRecipients(orgId, { status: "active", pageSize: 200, page: 1 });
  const inRun = useMemo(() => new Set(rows.map((r) => r.recipientId).filter(Boolean) as string[]), [rows]);
  const items = (list.data?.items ?? []).filter((r) => {
    const s = q.trim().toLowerCase();
    return !s || r.name.toLowerCase().includes(s) || r.walletAddress.toLowerCase().includes(s) || (r.department ?? "").toLowerCase().includes(s);
  });
  const selectable = items.filter((r) => !inRun.has(r.id));
  const allOn = selectable.length > 0 && selectable.every((r) => picked.has(r.id));

  function add() {
    const chosen = (list.data?.items ?? []).filter((r) => picked.has(r.id) && !inRun.has(r.id));
    setRows((prev) => [
      ...prev,
      ...chosen.map((r) =>
        newRow({
          recipientId: r.id,
          name: r.name,
          email: r.email ?? "",
          walletAddress: r.walletAddress,
          department: r.department ?? "",
          amount: r.defaultAmount ? weiToDecimalString(r.defaultAmount) : "",
        }),
      ),
    ]);
    setPicked(new Set());
  }

  if (list.isLoading) return <Skeleton className="h-48 w-full" />;
  if ((list.data?.items.length ?? 0) === 0) {
    return <p className="text-sm text-muted-foreground">No saved recipients yet. Upload a CSV or add people manually; you can save them to your directory later.</p>;
  }
  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Checkbox
          aria-label="Select all"
          checked={allOn ? true : picked.size ? "indeterminate" : false}
          onCheckedChange={(v) => setPicked(v ? new Set(selectable.map((r) => r.id)) : new Set())}
        />
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search saved recipients" className="h-8 pl-7" />
        </div>
      </div>
      <ul className="max-h-80 divide-y overflow-y-auto">
        {items.map((r) => {
          const already = inRun.has(r.id);
          return (
            <li key={r.id}>
              <label className={cn("flex items-center gap-3 px-3 py-2 text-sm", already ? "opacity-60" : "cursor-pointer hover:bg-muted/40")}>
                <Checkbox
                  disabled={already}
                  checked={already || picked.has(r.id)}
                  onCheckedChange={(v) =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (v) n.add(r.id);
                      else n.delete(r.id);
                      return n;
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{shortAddress(r.walletAddress)}</span>
                </span>
                <span className="text-[0.8125rem] text-muted-foreground">{already ? "Added" : r.department ?? ""}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between border-t px-3 py-2">
        <span className="num text-[0.8125rem] text-muted-foreground">{picked.size} selected</span>
        <Button size="sm" disabled={!picked.size} onClick={add}>
          Add to run
        </Button>
      </div>
    </div>
  );
}

function ManualMethod({ setRows }: { setRows: (fn: (r: DraftRow[]) => DraftRow[]) => void }) {
  const [v, setV] = useState({ name: "", walletAddress: "", amount: "", description: "" });
  const ready = v.name.trim() && v.walletAddress.trim() && v.amount.trim();
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setRows((prev) => [...prev, newRow(v)]);
        setV({ name: "", walletAddress: "", amount: "", description: "" });
        (e.currentTarget.elements.namedItem("m-name") as HTMLInputElement | null)?.focus();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium">
          Name
          <Input name="m-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Amount (MUSD)
          <Input inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} className="num" />
        </label>
      </div>
      <label className="grid gap-1.5 text-sm font-medium">
        Wallet address
        <Input value={v.walletAddress} onChange={(e) => setV({ ...v, walletAddress: e.target.value })} placeholder="0x…" className="font-mono text-[0.8125rem]" spellCheck={false} autoComplete="off" />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        <span>
          Note <span className="font-normal text-muted-foreground">(optional, only the recipient sees it)</span>
        </span>
        <Input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
      </label>
      <div>
        <Button type="submit" variant="outline" disabled={!ready}>
          Add row
        </Button>
      </div>
    </form>
  );
}

function RowList({ rows, setRows }: { rows: DraftRow[]; setRows: (fn: (r: DraftRow[]) => DraftRow[]) => void }) {
  return (
    <aside className="min-w-0 rounded-lg border bg-surface">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <p className="text-sm font-semibold">
          In this run <span className="num font-normal text-muted-foreground">({rows.length})</span>
        </p>
        {rows.length ? (
          <button type="button" onClick={() => setRows(() => [])} className="cursor-pointer text-[0.8125rem] text-muted-foreground hover:text-foreground">
            Clear all
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-sm text-muted-foreground">No one yet. Upload a CSV, pick saved recipients, or add people one by one.</p>
      ) : (
        <ul className="max-h-[420px] divide-y overflow-y-auto">
          {rows.slice(0, 300).map((r) => (
            <li key={r.key} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{r.name || <span className="text-muted-foreground">No name</span>}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">{r.walletAddress ? shortAddress(r.walletAddress) : "No wallet"}</span>
              </span>
              <span className="num shrink-0 text-[0.8125rem]">{r.amount || <span className="text-muted-foreground">No amount</span>}</span>
              <button type="button" aria-label={`Remove ${r.name || "row"}`} onClick={() => setRows((p) => p.filter((x) => x.key !== r.key))} className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="size-3.5" />
              </button>
            </li>
          ))}
          {rows.length > 300 ? <li className="px-4 py-2 text-[0.8125rem] text-muted-foreground">and {rows.length - 300} more. All rows are shown in the next step.</li> : null}
        </ul>
      )}
    </aside>
  );
}
