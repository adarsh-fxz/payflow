import type { ReactNode } from "react";
import { cn } from "@/lib/client/utils";

/** Label above value, used in plain rows (not cards). */
export function Stat({ label, value, hint, className }: { label: string; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[0.8125rem] text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-lg font-semibold tracking-[-0.01em]">{value}</dd>
      {hint ? <dd className="mt-0.5 text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}
