"use client";

import { formatMusd } from "@/lib/money";
import { CATEGORY_LABEL, shortAddress } from "@/lib/client/format";
import { CLAIM_WINDOW_MAX_DAYS, CLAIM_WINDOW_MIN_DAYS, type WizardState, type WizardValidation } from "@/lib/client/wizard";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/shared/field";

const PREVIEW = 100;

export function StepReview({ state, validation, onChange }: { state: WizardState; validation: WizardValidation | undefined; onChange: (p: Partial<WizardState>) => void }) {
  const included = validation?.checks.filter((c) => !c.excluded && c.valid) ?? [];
  const total = validation?.report.totalPayableWei ?? "0";
  const batches = Math.ceil(included.length / 100);
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_1.5fr]">
      <div className="space-y-6">
        <dl className="divide-y rounded-lg border">
          {[
            ["Run", state.name],
            ["Type", state.category ? CATEGORY_LABEL[state.category] : ""],
            ["Recipients", included.length.toLocaleString()],
            ["Total", `${formatMusd(total)} MUSD`],
            ["Excluded rows", (validation?.excludedCount ?? 0).toLocaleString()],
            ["On-chain batches", `${batches} ${batches === 1 ? "transaction" : "transactions"} to add payments`],
          ].map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-4 px-4 py-2.5 text-sm">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className={k === "Total" ? "num text-base font-semibold" : "num text-right"}>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <Field label="Pay date" htmlFor="run-date" optional hint="For your records and reminders.">
            <Input id="run-date" type="date" value={state.scheduledAt} onChange={(e) => onChange({ scheduledAt: e.target.value })} />
          </Field>
          <Field
            label="Claim window (days)"
            htmlFor="run-window"
            hint="Starts when you publish. Unclaimed MUSD can be refunded after it ends."
            error={
              !Number.isInteger(state.claimWindowDays) || state.claimWindowDays < CLAIM_WINDOW_MIN_DAYS || state.claimWindowDays > CLAIM_WINDOW_MAX_DAYS
                ? `Use ${CLAIM_WINDOW_MIN_DAYS} to ${CLAIM_WINDOW_MAX_DAYS} days`
                : undefined
            }
          >
            <Input
              id="run-window"
              type="number"
              inputMode="numeric"
              min={CLAIM_WINDOW_MIN_DAYS}
              max={CLAIM_WINDOW_MAX_DAYS}
              value={Number.isFinite(state.claimWindowDays) ? state.claimWindowDays : ""}
              onChange={(e) => onChange({ claimWindowDays: e.target.value === "" ? NaN : Number(e.target.value) })}
              className="num"
            />
          </Field>
        </div>
        <p className="text-[0.8125rem] text-muted-foreground">
          Saving creates an off-chain draft you can still edit. Next you&apos;ll add it on-chain, get it approved, fund it with MUSD and publish it.
        </p>
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border">
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Wallet</th>
                <th className="px-3 py-2 text-right font-medium">Amount (MUSD)</th>
              </tr>
            </thead>
            <tbody>
              {included.slice(0, PREVIEW).map((c) => (
                <tr key={c.row.key} className="border-t">
                  <td className="max-w-48 truncate px-3 py-2">{c.row.name}</td>
                  <td className="px-3 py-2 font-mono text-[0.8125rem]">{shortAddress(c.row.walletAddress)}</td>
                  <td className="num px-3 py-2 text-right">{c.amountWei ? formatMusd(c.amountWei) : c.row.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {included.length > PREVIEW ? <p className="border-t px-3 py-2 text-[0.8125rem] text-muted-foreground">and {(included.length - PREVIEW).toLocaleString()} more</p> : null}
      </div>
    </div>
  );
}
