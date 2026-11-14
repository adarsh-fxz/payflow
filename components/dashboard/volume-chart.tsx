"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DashboardStats } from "@/lib/api-types";
import { formatMusd } from "@/lib/money";

const SERIES = [
  { key: "funded", label: "Funded", color: "var(--chart-1)" },
  { key: "claimed", label: "Claimed", color: "var(--chart-2)" },
] as const;

function monthLabel(m: string) {
  // "2026-10" or ISO date → "Oct 26"
  const d = new Date(/^\d{4}-\d{2}$/.test(m) ? `${m}-01T00:00:00Z` : m);
  if (Number.isNaN(d.getTime())) return m;
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
}

const toNum = (wei: string) => Number(BigInt(wei) / 10n ** 14n) / 1e4;

export function VolumeChart({ data }: { data: DashboardStats["monthlyVolume"] }) {
  const [table, setTable] = useState(false);
  const rows = data.map((d) => ({ month: monthLabel(d.month), funded: toNum(d.fundedWei), claimed: toNum(d.claimedWei), fundedWei: d.fundedWei, claimedWei: d.claimedWei }));
  const empty = rows.length === 0 || rows.every((r) => r.funded === 0 && r.claimed === 0);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <ul className="flex items-center gap-4 text-[0.8125rem]" aria-label="Legend">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
        {!empty ? (
          <button type="button" onClick={() => setTable((t) => !t)} className="cursor-pointer text-[0.8125rem] text-muted-foreground hover:text-foreground">
            {table ? "Show chart" : "Show table"}
          </button>
        ) : null}
      </div>
      {empty ? (
        <p className="px-4 py-16 text-center text-sm text-muted-foreground">No funded runs yet. Monthly totals appear once a run is funded.</p>
      ) : table ? (
        <div className="overflow-x-auto px-4 py-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1.5 font-medium">Month</th>
                <th className="py-1.5 text-right font-medium">Funded (MUSD)</th>
                <th className="py-1.5 text-right font-medium">Claimed (MUSD)</th>
              </tr>
            </thead>
            <tbody className="num">
              {rows.map((r) => (
                <tr key={r.month} className="border-t">
                  <td className="py-1.5">{r.month}</td>
                  <td className="py-1.5 text-right">{formatMusd(r.fundedWei)}</td>
                  <td className="py-1.5 text-right">{formatMusd(r.claimedWei)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-64 px-2 pt-2 pb-3" role="img" aria-label="Monthly MUSD funded and claimed">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} barGap={2} barCategoryGap="28%" margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
              <YAxis
                width={52}
                tickLine={false}
                axisLine={false}
                tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                tickFormatter={(v: number) => Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v)}
              />
              <Tooltip
                cursor={{ fill: "var(--muted)", opacity: 0.6 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as (typeof rows)[number];
                  return (
                    <div className="rounded-md border bg-popover px-3 py-2 text-[0.8125rem] shadow-sm">
                      <p className="font-medium">{label}</p>
                      <p className="num mt-1 flex items-center gap-1.5">
                        <span className="size-2 rounded-[2px]" style={{ background: SERIES[0].color }} /> Funded {formatMusd(p.fundedWei)} MUSD
                      </p>
                      <p className="num flex items-center gap-1.5">
                        <span className="size-2 rounded-[2px]" style={{ background: SERIES[1].color }} /> Claimed {formatMusd(p.claimedWei)} MUSD
                      </p>
                    </div>
                  );
                }}
              />
              {SERIES.map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
