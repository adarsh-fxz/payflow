"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { isAddress } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import type { CreateOrgRequest, Organization } from "@/lib/api-types";
import { isDeployed } from "@/lib/chain/config";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/hooks/use-api";
import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/shared/field";
import { TxStatus } from "@/components/shared/tx-status";
import { useRegisterOrg } from "./register-org";

const schema = z.object({
  name: z.string().trim().min(2, "Use at least 2 characters").max(80, "Keep it under 80 characters"),
  description: z.string().trim().max(500, "Keep it under 500 characters"),
  logoUrl: z.union([z.literal(""), z.string().trim().url("Enter a full https:// link")]),
  email: z.union([z.literal(""), z.string().trim().max(254).email("Enter a valid email address")]),
  treasuryWallet: z.union([z.literal(""), z.string().trim().refine((v: string): boolean => isAddress(v), "Enter a valid 0x wallet address")]),
  defaultClaimWindowDays: z.number({ message: "Enter a number of days" }).int("Whole days only").min(1, "At least 1 day").max(365, "At most 365 days"),
});
type Values = z.infer<typeof schema>;

export function CreateOrgForm({ onCancel }: { onCancel?: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const w = useWallet();
  const reg = useRegisterOrg();
  const [stage, setStage] = useState<"form" | "saving" | "registering">("form");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Organization | null>(null);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", description: "", logoUrl: "", email: "", treasuryWallet: "", defaultClaimWindowDays: 30 },
  });

  async function onSubmit(v: Values) {
    setError(null);
    let org = created;
    if (!org) {
      setStage("saving");
      try {
        const body: CreateOrgRequest = {
          name: v.name,
          description: v.description || undefined,
          logoUrl: v.logoUrl || null,
          treasuryWallet: (v.treasuryWallet ? v.treasuryWallet.toLowerCase() : null) as CreateOrgRequest["treasuryWallet"],
          defaultClaimWindowDays: v.defaultClaimWindowDays,
          email: v.email || null,
        };
        org = await api<Organization>("/api/orgs", { method: "POST", json: body });
        setCreated(org);
        await qc.invalidateQueries({ queryKey: qk.orgs });
      } catch (e) {
        setError(errorMessage(e));
        setStage("form");
        return;
      }
    }
    if (!isDeployed) {
      router.push(`/app/${org.slug}`);
      return;
    }
    setStage("registering");
    const res = await reg.register(org);
    await qc.invalidateQueries({ queryKey: qk.orgs });
    if (res?.recorded) router.push(`/app/${org.slug}`);
    else setStage("form");
  }

  const busy = stage !== "form" || reg.isBusy;
  const e = form.formState.errors;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <Field label="Organization name" htmlFor="org-name" error={e.name?.message}>
        <Input id="org-name" autoFocus disabled={Boolean(created)} {...form.register("name")} aria-invalid={Boolean(e.name)} placeholder="Northwind Labs" />
      </Field>
      <Field label="Description" htmlFor="org-desc" optional error={e.description?.message} hint="Shown to recipients on their claim page.">
        <Textarea id="org-desc" rows={3} disabled={Boolean(created)} {...form.register("description")} aria-invalid={Boolean(e.description)} />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Logo URL" htmlFor="org-logo" optional error={e.logoUrl?.message}>
          <Input id="org-logo" disabled={Boolean(created)} {...form.register("logoUrl")} aria-invalid={Boolean(e.logoUrl)} placeholder="https://…" />
        </Field>
        <Field label="Default claim window (days)" htmlFor="org-window" error={e.defaultClaimWindowDays?.message} hint="How long recipients have to claim.">
          <Input
            id="org-window"
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            disabled={Boolean(created)}
            {...form.register("defaultClaimWindowDays", { valueAsNumber: true })}
            aria-invalid={Boolean(e.defaultClaimWindowDays)}
            className="num"
          />
        </Field>
      </div>
      <Field label="Your email" htmlFor="org-email" optional error={e.email?.message} hint="For payroll notices like approvals and claims. It never gives access to anything.">
        <Input id="org-email" type="email" autoComplete="email" disabled={Boolean(created)} {...form.register("email")} aria-invalid={Boolean(e.email)} />
      </Field>
      <Field label="Treasury wallet" htmlFor="org-treasury" optional error={e.treasuryWallet?.message} hint="For your records. Runs are funded by whichever admin wallet sends the funding transaction.">
        <Input id="org-treasury" disabled={Boolean(created)} {...form.register("treasuryWallet")} aria-invalid={Boolean(e.treasuryWallet)} placeholder="0x…" className="font-mono text-[0.8125rem]" spellCheck={false} />
      </Field>

      {error ? (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}
      <TxStatus state={reg.state} onRetryRecord={reg.retryRecord} />
      {reg.state.recordError && created ? (
        <Button type="button" variant="outline" onClick={() => router.push(`/app/${created.slug}`)}>
          Open the workspace anyway
        </Button>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t pt-5">
        <Button type="submit" disabled={busy || (isDeployed && !w.isReady)}>
          {stage === "saving" ? "Saving…" : stage === "registering" ? "Registering on Mezo…" : created ? "Register on Mezo" : isDeployed ? "Create and register" : "Create organization"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <p className="text-[0.8125rem] text-muted-foreground">
          {isDeployed ? "Registering sends one transaction from your wallet. You'll be the owner." : "On-chain registration turns on once contracts are deployed."}
        </p>
      </div>
    </form>
  );
}
