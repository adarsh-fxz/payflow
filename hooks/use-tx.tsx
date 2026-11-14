"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { toast } from "sonner";
import type { Hash, TransactionReceipt } from "viem";
import { explorerTx } from "@/lib/chain/config";
import { describeTxError, type TxError } from "@/lib/client/errors";
import { executeWrite, type WriteSpec } from "@/lib/client/writes";
import { errorMessage } from "@/lib/client/api";
import { shortHash } from "@/lib/client/format";

export type TxPhase = "idle" | "signing" | "pending" | "recording" | "success" | "error";

export interface TxState {
  phase: TxPhase;
  label: string;
  hash?: Hash;
  error?: TxError;
  /** The tx succeeded but PayFlow could not record it yet (safe to retry). */
  recordError?: string;
  /** Free-form progress, e.g. "Batch 2 of 3". */
  progress?: string;
}

const IDLE: TxState = { phase: "idle", label: "" };

export interface RunOptions {
  /** After the receipt: report the hash to the API (e.g. POST …/tx). Retried by `retryRecord`. */
  record?: (hash: Hash, receipt: TransactionReceipt) => Promise<unknown>;
  successMessage?: string;
  progress?: string;
  /** Keep quiet on success (used inside multi-tx sequences). */
  silent?: boolean;
  /** Called as soon as the wallet returns a hash, before the receipt (e.g. to persist it). */
  onSubmitted?: (hash: Hash) => void;
}

function ExplorerLink({ hash }: { hash: Hash }) {
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      View {shortHash(hash)} on explorer
    </a>
  );
}

/**
 * One on-chain write: wallet prompt → pending → receipt → POST hash to the API → success.
 * Failures stay visible in `state` (the TxStatus component renders them) and in a toast.
 */
export function useTx() {
  const config = useConfig();
  const qc = useQueryClient();
  const [state, setState] = useState<TxState>(IDLE);
  const busy = useRef(false);
  const lastRecord = useRef<{ fn: NonNullable<RunOptions["record"]>; hash: Hash; receipt: TransactionReceipt } | null>(null);

  const reset = useCallback(() => {
    setState(IDLE);
    lastRecord.current = null;
  }, []);

  const run = useCallback(
    async (s: WriteSpec, opts: RunOptions = {}): Promise<{ hash: Hash; receipt: TransactionReceipt; recorded: boolean } | null> => {
      if (busy.current) return null;
      busy.current = true;
      const toastId = `tx-${s.label}-${Date.now()}`;
      setState({ phase: "signing", label: s.label, progress: opts.progress });
      toast.loading(`${s.label}: confirm in your wallet`, { id: toastId, description: opts.progress });
      let hash: Hash | undefined;
      try {
        const res = await executeWrite(config, s, (h) => {
          hash = h;
          opts.onSubmitted?.(h);
          setState({ phase: "pending", label: s.label, hash: h, progress: opts.progress });
          toast.loading(`${s.label}: waiting for confirmation`, { id: toastId, description: <ExplorerLink hash={h} /> });
        });
        hash = res.hash;
        if (opts.record) {
          setState({ phase: "recording", label: s.label, hash, progress: opts.progress });
          lastRecord.current = { fn: opts.record, hash: res.hash, receipt: res.receipt };
          try {
            await opts.record(res.hash, res.receipt);
            lastRecord.current = null;
          } catch (err) {
            const msg = errorMessage(err);
            setState({ phase: "success", label: s.label, hash, recordError: msg, progress: opts.progress });
            toast.warning(`${s.label}: confirmed on-chain, not recorded yet`, { id: toastId, description: msg });
            busy.current = false;
            void qc.invalidateQueries({ queryKey: ["chain"] });
            void qc.invalidateQueries({ queryKey: ["api"] });
            return { ...res, recorded: false };
          }
        }
        setState({ phase: "success", label: s.label, hash, progress: opts.progress });
        if (opts.silent) toast.dismiss(toastId);
        else toast.success(opts.successMessage ?? `${s.label}: done`, { id: toastId, description: <ExplorerLink hash={res.hash} /> });
        busy.current = false;
        void qc.invalidateQueries();
        return { ...res, recorded: true };
      } catch (err) {
        const e = describeTxError(err);
        const failedHash = (err as { hash?: Hash }).hash ?? hash;
        setState({ phase: "error", label: s.label, hash: failedHash, error: e, progress: opts.progress });
        if (e.kind === "rejected") toast.message(e.title, { id: toastId, description: e.message });
        else toast.error(`${s.label} failed`, { id: toastId, description: e.message });
        busy.current = false;
        // Something changed or was misread (balance, allowance, run state): refetch everything on screen.
        void qc.invalidateQueries();
        return null;
      }
    },
    [config, qc],
  );

  const retryRecord = useCallback(async () => {
    const r = lastRecord.current;
    if (!r) return;
    setState((s) => ({ ...s, phase: "recording", recordError: undefined }));
    try {
      await r.fn(r.hash, r.receipt);
      lastRecord.current = null;
      setState((s) => ({ ...s, phase: "success", recordError: undefined }));
      toast.success("Recorded");
      void qc.invalidateQueries();
    } catch (err) {
      setState((s) => ({ ...s, phase: "success", recordError: errorMessage(err) }));
    }
  }, [qc]);

  return { state, run, reset, retryRecord, setState, isBusy: state.phase === "signing" || state.phase === "pending" || state.phase === "recording" };
}
