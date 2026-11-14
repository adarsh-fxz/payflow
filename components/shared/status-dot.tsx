import { cn } from "@/lib/client/utils";
import type { Tone } from "@/lib/client/status";

const DOT: Record<Tone, string> = {
  idle: "bg-idle",
  info: "bg-info",
  warn: "bg-warn",
  ok: "bg-ok",
  bad: "bg-bad",
  brand: "bg-brand",
};

/** A dot plus a word. Colour is never the only signal. */
export function StatusDot({ tone, label, className }: { tone: Tone; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm whitespace-nowrap", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
      {label}
    </span>
  );
}
