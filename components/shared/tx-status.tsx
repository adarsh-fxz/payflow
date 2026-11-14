"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import type { TxState } from "@/hooks/use-tx";
import { cn } from "@/lib/client/utils";
import { TxLink } from "./address";

const COPY: Record<TxState["phase"], string> = {
  idle: "",
  signing: "Confirm in your wallet",
  pending: "Waiting for Mezo Testnet to confirm",
  recording: "Confirmed. Saving to PayFlow",
  success: "Done",
  error: "Failed",
};

/** Inline, persistent tx feedback. Failures stay on screen until the next attempt. */
export function TxStatus({ state, onRetryRecord, className }: { state: TxState; onRetryRecord?: () => void; className?: string }) {
  const reduce = useReducedMotion();
  const busy = state.phase === "signing" || state.phase === "pending" || state.phase === "recording";
  return (
    <AnimatePresence initial={false}>
      {state.phase !== "idle" ? (
        <motion.div
          key="tx"
          initial={reduce ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
          role={state.phase === "error" ? "alert" : "status"}
          aria-live="polite"
          className={cn(
            "rounded-md border px-3 py-2.5 text-sm",
            state.phase === "error" ? "border-bad/40 bg-bad/5" : state.recordError ? "border-warn/50 bg-warn/5" : "bg-surface",
            className,
          )}
        >
          <div className="flex items-start gap-2">
            {busy ? (
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : state.phase === "error" || state.recordError ? (
              <CircleAlert className={cn("mt-0.5 size-4 shrink-0", state.phase === "error" ? "text-bad" : "text-warn")} />
            ) : (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {state.label}
                {state.progress ? <span className="font-normal text-muted-foreground"> · {state.progress}</span> : null}
              </p>
              <p className="text-muted-foreground">
                {state.phase === "error"
                  ? `${state.error?.title ?? "Failed"}. ${state.error?.message ?? ""}`
                  : state.recordError
                    ? `Confirmed on-chain, but PayFlow could not save it yet: ${state.recordError}`
                    : COPY[state.phase]}
              </p>
              {state.hash || (state.recordError && onRetryRecord) ? (
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  {state.hash ? <TxLink hash={state.hash} label="View transaction" /> : null}
                  {state.recordError && onRetryRecord ? (
                    <button type="button" onClick={onRetryRecord} className="cursor-pointer text-[0.8125rem] font-medium underline underline-offset-4">
                      Retry saving
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
