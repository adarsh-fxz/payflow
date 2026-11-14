"use client";

import type { PaymentCategory } from "@/lib/api-types";
import { cn } from "@/lib/client/utils";
import type { WizardState } from "@/lib/client/wizard";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/shared/field";

const TYPES: { value: PaymentCategory; label: string; body: string }[] = [
  { value: "salary", label: "Salary", body: "Regular pay for employees" },
  { value: "contractor", label: "Contractor", body: "Invoices and fixed fees" },
  { value: "bounty", label: "Bounty", body: "Rewards for finished tasks" },
  { value: "reward", label: "Reward", body: "Community or contributor rewards" },
  { value: "grant", label: "Grant", body: "Grant payments or tranches" },
  { value: "custom", label: "Custom", body: "Anything else" },
];

export function StepType({ state, onChange, onNameChange }: { state: WizardState; onChange: (p: Partial<WizardState>) => void; onNameChange: (name: string) => void }) {
  return (
    <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr]">
      <fieldset>
        <legend className="text-sm font-semibold">What kind of payment is this?</legend>
        <div role="radiogroup" className="mt-3 grid gap-2 sm:grid-cols-2">
          {TYPES.map((t) => {
            const on = state.category === t.value;
            return (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange({ category: t.value })}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-[border-color,background-color,box-shadow] duration-150",
                  on ? "border-foreground bg-surface shadow-[0_0_0_1px_var(--foreground)]" : "hover:border-foreground/30 hover:bg-muted/40",
                )}
              >
                <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", on && "border-foreground")}>
                  {on ? <span className="size-2 rounded-full bg-foreground" /> : null}
                </span>
                <span>
                  <span className="block text-sm font-medium">{t.label}</span>
                  <span className="block text-[0.8125rem] text-muted-foreground">{t.body}</span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="space-y-5">
        <Field label="Run name" htmlFor="run-name" hint="Recipients see this on their claim page.">
          <Input id="run-name" value={state.name} onChange={(e) => onNameChange(e.target.value)} placeholder="November 2026 salary" maxLength={120} />
        </Field>
        <fieldset>
          <legend className="text-sm font-medium">How often</legend>
          <div className="mt-2 inline-flex rounded-md border p-0.5">
            {(["one_time", "monthly"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={state.frequency === f}
                onClick={() => onChange({ frequency: f })}
                className={cn("cursor-pointer rounded px-3 py-1 text-sm", state.frequency === f ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
              >
                {f === "one_time" ? "One time" : "Monthly"}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[0.8125rem] text-muted-foreground">
            {state.frequency === "monthly" ? "Saved as a monthly run. To create drafts automatically, set up a schedule." : "A single payout."}
          </p>
        </fieldset>
      </div>
    </div>
  );
}
