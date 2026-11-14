"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useReadContract } from "wagmi";
import type { CreateRunRequest, PayrollRun, Recipient } from "@/lib/api-types";
import { erc20Abi } from "@/lib/chain/abis";
import { contracts, MEZO_TESTNET_ID } from "@/lib/chain/config";
import { api, errorMessage } from "@/lib/client/api";
import { CATEGORY_LABEL } from "@/lib/client/format";
import { cn } from "@/lib/client/utils";
import { canAdvance, maxReachableStep, newRow, toRunItems, validateRows, WIZARD_STEPS, type DraftRow, type WizardState } from "@/lib/client/wizard";
import { weiToDecimalString } from "@/lib/money";
import { useWallet } from "@/hooks/use-wallet";
import { useOrg } from "@/components/org/org-context";
import { canOperate } from "@/lib/client/roles";
import { Button } from "@/components/ui/button";
import { StepType } from "./step-type";
import { StepRecipients } from "./step-recipients";
import { StepCheck } from "./step-check";
import { StepReview } from "./step-review";

function defaultName(category: string | null) {
  const month = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return category ? `${month} ${CATEGORY_LABEL[category as keyof typeof CATEGORY_LABEL].toLowerCase()}` : "";
}

export function PayrollWizard() {
  const org = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const w = useWallet();

  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [state, setState] = useState<WizardState>({
    name: "",
    category: null,
    frequency: "one_time",
    rows: [],
    excluded: new Set(),
    scheduledAt: "",
    claimWindowDays: org.defaultClaimWindowDays || 30,
  });
  const [nameTouched, setNameTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // employer balance (for the "not enough MUSD" warning only; never blocks saving a draft)
  const balance = useReadContract({
    address: contracts.musd,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: w.address ? [w.address] : undefined,
    chainId: MEZO_TESTNET_ID,
    query: { enabled: Boolean(w.address) },
  });

  // Prefill one saved recipient from ?recipient=<id>
  const prefilled = useRef(false);
  useEffect(() => {
    const rid = params.get("recipient");
    if (!rid || prefilled.current) return;
    prefilled.current = true;
    api<Recipient>(`/api/orgs/${org.id}/recipients/${rid}`)
      .then((r) =>
        setState((s) => ({
          ...s,
          rows: [
            ...s.rows,
            newRow({ recipientId: r.id, name: r.name, email: r.email ?? "", walletAddress: r.walletAddress, department: r.department ?? "", amount: r.defaultAmount ? weiToDecimalString(r.defaultAmount) : "" }),
          ],
        })),
      )
      .catch(() => undefined);
  }, [params, org.id]);

  const deferredRows = useDeferredValue(state.rows);
  const deferredExcluded = useDeferredValue(state.excluded);
  const balanceWei = typeof balance.data === "bigint" ? balance.data.toString() : undefined;
  const validation = useMemo(
    () => (deferredRows.length ? validateRows(deferredRows, deferredExcluded, { employerBalanceWei: balanceWei }) : undefined),
    [deferredRows, deferredExcluded, balanceWei],
  );
  const stale = deferredRows !== state.rows || deferredExcluded !== state.excluded;

  const key = WIZARD_STEPS[step].key;
  const gate = stale ? ({ ok: false, reason: "Checking rows…" } as const) : canAdvance(key, state, validation);
  const reachable = maxReachableStep(state, stale ? undefined : validation);

  function go(to: number) {
    setDir(to > step ? 1 : -1);
    setStep(to);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }

  function patch(p: Partial<WizardState>) {
    setState((s) => {
      const next = { ...s, ...p };
      if (p.category && !nameTouched) next.name = defaultName(p.category);
      return next;
    });
  }
  function setRows(fn: (rows: DraftRow[]) => DraftRow[]) {
    setState((s) => ({ ...s, rows: fn(s.rows) }));
  }
  function setExcluded(fn: (ex: Set<string>) => Set<string>) {
    setState((s) => ({ ...s, excluded: fn(new Set(s.excluded)) }));
  }

  async function saveDraft() {
    if (!validation || !state.category) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body: CreateRunRequest = {
        name: state.name.trim(),
        paymentCategory: state.category,
        frequency: state.frequency,
        scheduledAt: state.scheduledAt ? new Date(`${state.scheduledAt}T00:00:00`).toISOString() : null,
        claimWindowDays: state.claimWindowDays,
        items: toRunItems(validation),
      };
      const run = await api<PayrollRun>(`/api/orgs/${org.id}/runs`, { method: "POST", json: body });
      await qc.invalidateQueries({ queryKey: ["api", "org", org.id] });
      router.push(`/app/${org.slug}/runs/${run.id}?created=1`);
    } catch (e) {
      setSaveError(errorMessage(e));
      setSaving(false);
    }
  }

  if (!canOperate(org.myRoles)) {
    return (
      <div className="max-w-lg py-10">
        <h1 className="text-xl font-semibold">You can&apos;t create runs here</h1>
        <p className="mt-2 text-sm text-muted-foreground">Building payroll runs needs the operator or admin role. Ask an admin of {org.name} to add it in Settings.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto min-w-0 max-w-[1100px] pb-4">
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.01em]">New payroll run</h1>
          <p className="mt-1 text-sm text-muted-foreground">Nothing goes on-chain until you save the draft and submit it.</p>
        </div>
      </div>

      <nav aria-label="Steps" className="mb-8">
        <ol className="flex items-center gap-1 overflow-x-auto sm:gap-2">
          {WIZARD_STEPS.map((s, i) => {
            const done = i < step;
            const current = i === step;
            const can = i <= reachable;
            return (
              <li key={s.key} className="flex shrink-0 items-center gap-1 sm:gap-2">
                <button
                  type="button"
                  disabled={!can || current}
                  onClick={() => go(i)}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                    current ? "font-medium text-foreground" : can ? "cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground" : "text-muted-foreground/60",
                  )}
                >
                  <span
                    className={cn(
                      "num flex size-6 items-center justify-center rounded-full border text-xs",
                      current && "border-foreground bg-foreground text-background",
                      done && "border-transparent bg-brand text-[oklch(0.2_0.01_60)]",
                    )}
                  >
                    {done ? <Check className="size-3.5" strokeWidth={2.5} /> : i + 1}
                  </span>
                  {s.label}
                </button>
                {i < WIZARD_STEPS.length - 1 ? <span aria-hidden className="h-px w-4 bg-border sm:w-8" /> : null}
              </li>
            );
          })}
          <li className="flex shrink-0 items-center gap-1 pl-1 text-sm text-muted-foreground/70 sm:gap-2">
            <span aria-hidden className="h-px w-4 bg-border sm:w-8" />
            Then on-chain: submit, approve, fund, publish
          </li>
        </ol>
      </nav>

      <AnimatePresence mode="wait" initial={false} custom={dir}>
        <motion.div
          key={key}
          custom={dir}
          initial={reduce ? false : { opacity: 0, x: 12 * dir }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? undefined : { opacity: 0, x: -8 * dir }}
          transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
        >
          {key === "type" ? (
            <StepType
              state={state}
              onChange={patch}
              onNameChange={(name) => {
                setNameTouched(true);
                patch({ name });
              }}
            />
          ) : key === "recipients" ? (
            <StepRecipients orgId={org.id} rows={state.rows} setRows={setRows} />
          ) : key === "validate" ? (
            <StepCheck rows={state.rows} validation={validation} stale={stale} setRows={setRows} setExcluded={setExcluded} balanceWei={balanceWei} />
          ) : (
            <StepReview state={state} validation={validation} onChange={patch} />
          )}
        </motion.div>
      </AnimatePresence>

      {/* data-sticky-footer: globals.css adds matching scroll padding so focused rows never sit under it. */}
      <div data-sticky-footer className="sticky bottom-0 z-[var(--z-sticky)] -mx-4 mt-8 border-t bg-background/95 px-4 py-2.5 backdrop-blur-sm sm:-mx-6 sm:px-6 sm:py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button variant="ghost" onClick={() => (step === 0 ? router.push(`/app/${org.slug}/runs`) : go(step - 1))} disabled={saving}>
            <ArrowLeft data-icon="inline-start" /> {step === 0 ? "Cancel" : "Back"}
          </Button>
          <p role="status" className={cn("order-last w-full min-w-0 text-[0.8125rem] sm:order-none sm:w-auto sm:flex-1", gate.ok ? "text-muted-foreground" : "text-foreground", !saveError && gate.ok && "hidden sm:block")}>
            {saveError ? <span className="text-bad">{saveError}</span> : gate.ok ? "" : gate.reason}
          </p>
          {key === "review" ? (
            <Button className="ml-auto" onClick={() => void saveDraft()} disabled={!gate.ok || saving}>
              {saving ? "Saving draft…" : "Save draft and continue"}
            </Button>
          ) : (
            <Button className="ml-auto" onClick={() => go(step + 1)} disabled={!gate.ok}>
              Continue <ArrowRight data-icon="inline-end" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
