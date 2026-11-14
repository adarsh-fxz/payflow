"use client";

import { CloudOff } from "lucide-react";
import { relativeTime } from "@/lib/client/format";
import { cn } from "@/lib/client/utils";
import { useHealth } from "@/hooks/use-api";
import { useNow } from "@/hooks/use-now";

/** True when the API reports the RPC down. Cheap: /api/health is cached for a minute. */
export function useRpcDown(): boolean {
  const h = useHealth();
  return h.data?.rpc === "down";
}

/**
 * Shown when Mezo can't be reached. With saved data on screen it says so and how old it is;
 * without any, it says what will happen next instead of "Internal error".
 */
export function ChainBanner({ hasData, updatedAt, className }: { hasData: boolean; updatedAt?: string | number | null; className?: string }) {
  return (
    <div role="status" className={cn("flex items-start gap-2.5 rounded-lg border border-warn/50 bg-warn/[0.07] px-4 py-3 text-sm", className)}>
      <CloudOff className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{hasData ? "Can't reach Mezo right now; showing the last saved data." : "Can't reach Mezo right now."}</p>
        <p className="mt-0.5 text-muted-foreground">
          {hasData ? (
            <>
              Balances and statuses may be out of date. {updatedAt ? <DataAge at={updatedAt} prefix="Saved" /> : null} Checking again automatically.
            </>
          ) : (
            "Nothing was lost. PayFlow keeps checking and will update this page when Mezo answers."
          )}
        </p>
      </div>
    </div>
  );
}

/** "Updated 3 minutes ago", re-rendered with the shared clock. */
export function DataAge({ at, prefix = "Updated", className }: { at: string | number | Date; prefix?: string; className?: string }) {
  const now = useNow();
  const iso = new Date(at).toISOString();
  if (!now) return null;
  return (
    <span className={className} title={new Date(at).toLocaleString()}>
      {prefix} {relativeTime(iso, now)}.
    </span>
  );
}
