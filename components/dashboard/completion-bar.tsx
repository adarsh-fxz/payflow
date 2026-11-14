import type { DashboardStats } from "@/lib/api-types";
import { cn } from "@/lib/client/utils";

const PARTS = [
  { key: "claimed", label: "Claimed", cls: "bg-ok" },
  { key: "unclaimed", label: "Unclaimed", cls: "bg-warn" },
  { key: "cancelled", label: "Cancelled", cls: "bg-bad" },
  { key: "expired", label: "Expired", cls: "bg-idle" },
] as const;

/** Part-to-whole of payment states: one segmented bar plus a labelled legend with counts. */
export function CompletionBar({ data }: { data: DashboardStats["claimCompletion"] }) {
  const total = PARTS.reduce((n, p) => n + (data[p.key] ?? 0), 0);
  if (total === 0) {
    return <p className="px-4 py-10 text-sm text-muted-foreground">No published payments yet. Claim progress shows here once a run is open for claims.</p>;
  }
  const pct = (n: number) => (n / total) * 100;
  const claimedPct = Math.round(pct(data.claimed));
  return (
    <div className="px-4 py-4">
      <p className="text-sm">
        <span className="num text-2xl font-semibold tracking-[-0.01em]">{claimedPct}%</span>
        <span className="text-muted-foreground"> of {total.toLocaleString()} payments claimed</span>
      </p>
      <div className="mt-4 flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label={PARTS.map((p) => `${p.label} ${data[p.key]}`).join(", ")}>
        {PARTS.filter((p) => data[p.key] > 0).map((p) => (
          <div key={p.key} title={`${p.label}: ${data[p.key].toLocaleString()}`} className={cn("h-full first:rounded-l-[4px] last:rounded-r-[4px]", p.cls)} style={{ width: `${pct(data[p.key])}%` }} />
        ))}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {PARTS.map((p) => (
          <div key={p.key} className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <span aria-hidden className={cn("size-2 rounded-[2px]", p.cls)} />
              {p.label}
            </dt>
            <dd className="num font-medium">{data[p.key].toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
