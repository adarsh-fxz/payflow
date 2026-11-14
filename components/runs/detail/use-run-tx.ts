"use client";

import type { Hash } from "viem";
import type { PayrollRunDetail, RunTxAction } from "@/lib/api-types";
import { api } from "@/lib/client/api";
import type { WriteSpec } from "@/lib/client/writes";
import { useTx, type RunOptions } from "@/hooks/use-tx";

/** useTx bound to one run: every confirmed tx is POSTed to /runs/:id/tx with its action. */
export function useRunTx(orgId: string, runId: string) {
  const tx = useTx();
  function send(action: RunTxAction, spec: WriteSpec, opts: Omit<RunOptions, "record"> & { rejectionReason?: string } = {}) {
    const { rejectionReason, ...rest } = opts;
    return tx.run(spec, {
      ...rest,
      record: (hash: Hash) =>
        api<PayrollRunDetail>(`/api/orgs/${orgId}/runs/${runId}/tx`, {
          method: "POST",
          json: { action, txHash: hash, ...(rejectionReason ? { rejectionReason } : {}) },
        }),
    });
  }
  return { ...tx, send };
}
