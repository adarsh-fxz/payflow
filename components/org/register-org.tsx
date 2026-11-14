"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Hash } from "viem";
import type { Organization, RecoverOrgResponse } from "@/lib/api-types";
import { isDeployed } from "@/lib/chain/config";
import { api, ApiClientError, errorMessage } from "@/lib/client/api";
import { shortHash } from "@/lib/client/format";
import { build } from "@/lib/client/writes";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { TxStatus } from "@/components/shared/tx-status";
import { TxLink } from "@/components/shared/address";

/* A registration tx hash, kept until PayFlow has confirmed it, so a reload can finish the job. */
const key = (orgId: string) => `payflow:org-register:${orgId}`;
export function readPendingRegistration(orgId: string): Hash | null {
  try {
    const v = window.localStorage.getItem(key(orgId));
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hash) : null;
  } catch {
    return null;
  }
}
function writePendingRegistration(orgId: string, hash: Hash | null) {
  try {
    if (hash) window.localStorage.setItem(key(orgId), hash);
    else window.localStorage.removeItem(key(orgId));
  } catch {
    /* storage blocked: the recover endpoint still finds it */
  }
}

export type RecoverResult = "registered" | "none" | "unknown";

/**
 * Asks the API whether this org already exists on-chain (a register tx that confirmed but was never
 * recorded). "unknown" means we couldn't tell (endpoint missing or chain unreachable).
 */
export async function recoverOrg(orgId: string): Promise<{ result: RecoverResult; message?: string }> {
  try {
    const r = await api<RecoverOrgResponse>(`/api/orgs/${orgId}/recover`, { method: "POST", json: {} });
    return { result: r.recovered || r.organization?.status === "active" ? "registered" : "none" };
  } catch (e) {
    // 404 = this API has no recover endpoint yet; 503 = Mezo unreachable. Either way we can't tell.
    const message = e instanceof ApiClientError && e.status === 404 ? "the check isn't available on this server" : errorMessage(e);
    return { result: "unknown", message };
  }
}

/** Sends createOrganization(metadataHash) and confirms the tx with the API, recovering first. */
export function useRegisterOrg() {
  const tx = useTx();
  const qc = useQueryClient();

  async function confirmHash(org: Organization, hash: Hash) {
    await api<Organization>(`/api/orgs/${org.id}/confirm`, { method: "POST", json: { txHash: hash } });
    writePendingRegistration(org.id, null);
    await qc.invalidateQueries({ queryKey: ["api"] });
  }

  /** Never sends a second on-chain registration if an earlier one went through. */
  async function register(org: Organization, opts: { skipRecover?: boolean } = {}): Promise<{ recorded: boolean; recovered?: boolean } | null> {
    const pending = readPendingRegistration(org.id);
    if (pending) {
      try {
        await confirmHash(org, pending);
        return { recorded: true, recovered: true };
      } catch {
        /* fall through to recover */
      }
    }
    if (!opts.skipRecover) {
      const r = await recoverOrg(org.id);
      if (r.result === "registered") {
        writePendingRegistration(org.id, null);
        await qc.invalidateQueries({ queryKey: ["api"] });
        return { recorded: true, recovered: true };
      }
    }
    const res = await tx.run(build.createOrganization(org.metadataHash), {
      onSubmitted: (hash) => writePendingRegistration(org.id, hash),
      record: (hash: Hash) => confirmHash(org, hash),
      successMessage: "Organization registered on Mezo",
    });
    return res ? { recorded: res.recorded } : null;
  }

  return { ...tx, register, confirmHash };
}

type Check = { state: "checking" } | { state: "none" } | { state: "unknown"; message?: string } | { state: "pending"; hash: Hash; message?: string };

export function RegisterOrgBanner({ org }: { org: Organization }) {
  const reg = useRegisterOrg();
  const qc = useQueryClient();
  const w = useWallet();
  const isOwner = w.address?.toLowerCase() === org.ownerWallet.toLowerCase();
  const [check, setCheck] = useState<Check>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);

  // On load: finish a registration this browser started, else ask the API whether one exists.
  useEffect(() => {
    if (!isDeployed) return;
    let live = true;
    (async () => {
      const pending = readPendingRegistration(org.id);
      if (pending) {
        try {
          await reg.confirmHash(org, pending);
          return;
        } catch (e) {
          const r = await recoverOrg(org.id);
          if (!live) return;
          if (r.result === "registered") {
            writePendingRegistration(org.id, null);
            await qc.invalidateQueries({ queryKey: ["api"] });
            return;
          }
          setCheck({ state: "pending", hash: pending, message: errorMessage(e) });
          return;
        }
      }
      const r = await recoverOrg(org.id);
      if (!live) return;
      if (r.result === "registered") {
        await qc.invalidateQueries({ queryKey: ["api"] });
        return;
      }
      setCheck(r.result === "none" ? { state: "none" } : { state: "unknown", message: r.message });
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.id, attempt]);

  const busy = reg.isBusy || check.state === "checking";

  return (
    <div className="border-b border-warn/40 bg-warn/[0.07] px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="min-w-0 flex-1">
          <p>
            <span className="font-medium">{check.state === "pending" ? "Registration sent, not confirmed yet." : "Not registered on-chain yet."}</span>{" "}
            <span className="text-muted-foreground">
              {!isDeployed
                ? "Contracts are not deployed yet, so registration is turned off. Recipients and drafts still work."
                : check.state === "checking"
                  ? "Checking Mezo for an earlier registration…"
                  : check.state === "pending"
                    ? "PayFlow is waiting for your registration transaction. Don't register again; check again in a minute."
                    : "You can add recipients and drafts now. Register to create runs on-chain."}
            </span>
          </p>
          {check.state === "pending" ? (
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">
              Transaction <TxLink hash={check.hash} label={shortHash(check.hash)} />
              {check.message ? ` · ${check.message}` : null}
            </p>
          ) : null}
          {isDeployed && isOwner && check.state === "none" ? (
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">No earlier registration was found on Mezo. Registering sends one transaction; do it once.</p>
          ) : null}
          {isDeployed && isOwner && check.state === "unknown" ? (
            <p className="mt-1 text-[0.8125rem] text-warn">
              PayFlow couldn&apos;t check Mezo for an earlier registration{check.message ? ` (${check.message})` : ""}. If you already registered from another device, wait and check again: registering twice creates a second organization on-chain.
            </p>
          ) : null}
        </div>
        {isDeployed && isOwner && check.state !== "checking" ? (
          <div className="flex shrink-0 gap-2">
            {check.state !== "none" ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => {
                  setCheck({ state: "checking" });
                  setAttempt((a) => a + 1);
                }}
              >
                Check again
              </Button>
            ) : null}
            {check.state !== "pending" ? (
              <Button
                size="sm"
                variant={check.state === "unknown" ? "outline" : "default"}
                disabled={busy || !w.isReady}
                onClick={() => {
                  if (check.state === "unknown" && !confirm("PayFlow couldn't confirm there's no earlier registration. Register anyway? If one already went through, this creates a second organization on-chain.")) return;
                  void reg.register(org);
                }}
              >
                {reg.isBusy ? "Registering…" : check.state === "unknown" ? "Register anyway" : "Register on Mezo"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <TxStatus state={reg.state} onRetryRecord={reg.retryRecord} className="mt-3 max-w-xl" />
    </div>
  );
}
