"use client";

import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { PaymentCategory, PaymentFrequency, Recipient, RecipientInput } from "@/lib/api-types";
import { checkRecipientWallet } from "@/lib/csv/validate";
import { tryParseMusd, weiToDecimalString } from "@/lib/money";
import { api, errorMessage } from "@/lib/client/api";
import { CATEGORY_LABEL, FREQUENCY_LABEL } from "@/lib/client/format";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field } from "@/components/shared/field";

const NONE = "__none";

const schema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200, "Keep it under 200 characters"),
  email: z.union([z.literal(""), z.string().trim().email("Enter a valid email")]),
  walletAddress: z.string().trim().superRefine((v, ctx) => {
    const r = checkRecipientWallet(v);
    if (!r.ok) ctx.addIssue({ code: "custom", message: r.message });
  }),
  externalId: z.string().trim().max(100, "Keep it under 100 characters"),
  department: z.string().trim().max(100, "Keep it under 100 characters"),
  paymentCategory: z.string(),
  paymentFrequency: z.string(),
  defaultAmount: z.string().trim().refine((v) => v === "" || ((tryParseMusd(v) ?? -1n) > 0n), "Enter an amount above zero, e.g. 1500.50"),
});
type Values = z.infer<typeof schema>;

function toValues(r?: Recipient | null): Values {
  return {
    name: r?.name ?? "",
    email: r?.email ?? "",
    walletAddress: r?.walletAddress ?? "",
    externalId: r?.externalId ?? "",
    department: r?.department ?? "",
    paymentCategory: r?.paymentCategory ?? NONE,
    paymentFrequency: r?.paymentFrequency ?? NONE,
    defaultAmount: r?.defaultAmount ? weiToDecimalString(r.defaultAmount) : "",
  };
}

export function RecipientDialog({
  orgId,
  open,
  onOpenChange,
  recipient,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  recipient?: Recipient | null;
}) {
  const qc = useQueryClient();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toValues(recipient) });
  useEffect(() => {
    if (open) form.reset(toValues(recipient));
  }, [open, recipient, form]);

  const save = useMutation({
    mutationFn: (v: Values) => {
      const body: RecipientInput = {
        name: v.name,
        email: v.email || null,
        walletAddress: v.walletAddress,
        externalId: v.externalId || null,
        department: v.department || null,
        paymentCategory: v.paymentCategory === NONE ? null : (v.paymentCategory as PaymentCategory),
        paymentFrequency: v.paymentFrequency === NONE ? null : (v.paymentFrequency as PaymentFrequency),
        defaultAmount: v.defaultAmount || null,
      };
      return recipient
        ? api<Recipient>(`/api/orgs/${orgId}/recipients/${recipient.id}`, { method: "PATCH", json: body })
        : api<Recipient>(`/api/orgs/${orgId}/recipients`, { method: "POST", json: body });
    },
    onSuccess: async () => {
      toast.success(recipient ? "Recipient updated" : "Recipient added");
      await qc.invalidateQueries({ queryKey: ["api", "org", orgId] });
      onOpenChange(false);
    },
  });

  const e = form.formState.errors;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{recipient ? "Edit recipient" : "Add recipient"}</DialogTitle>
          <DialogDescription>Payments go to this wallet. Double-check it; a payment sent to the wrong wallet can&apos;t be recovered.</DialogDescription>
        </DialogHeader>
        <form id="recipient-form" onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="rc-name" error={e.name?.message}>
              <Input id="rc-name" {...form.register("name")} aria-invalid={Boolean(e.name)} />
            </Field>
            <Field label="Email" htmlFor="rc-email" optional error={e.email?.message}>
              <Input id="rc-email" type="email" {...form.register("email")} aria-invalid={Boolean(e.email)} />
            </Field>
          </div>
          <Field label="Wallet address" htmlFor="rc-wallet" error={e.walletAddress?.message}>
            <Input id="rc-wallet" {...form.register("walletAddress")} aria-invalid={Boolean(e.walletAddress)} placeholder="0x…" className="font-mono text-[0.8125rem]" spellCheck={false} autoComplete="off" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Department" htmlFor="rc-dept" optional error={e.department?.message}>
              <Input id="rc-dept" {...form.register("department")} />
            </Field>
            <Field label="Employee or contractor ID" htmlFor="rc-ext" optional error={e.externalId?.message}>
              <Input id="rc-ext" {...form.register("externalId")} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Type" htmlFor="rc-cat" optional>
              <Controller
                control={form.control}
                name="paymentCategory"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="rc-cat" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not set</SelectItem>
                      {Object.entries(CATEGORY_LABEL).map(([k, l]) => (
                        <SelectItem key={k} value={k}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field label="Frequency" htmlFor="rc-freq" optional>
              <Controller
                control={form.control}
                name="paymentFrequency"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="rc-freq" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not set</SelectItem>
                      {Object.entries(FREQUENCY_LABEL).map(([k, l]) => (
                        <SelectItem key={k} value={k}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field label="Default amount" htmlFor="rc-amt" optional error={e.defaultAmount?.message}>
              <div className="relative">
                <Input id="rc-amt" inputMode="decimal" {...form.register("defaultAmount")} aria-invalid={Boolean(e.defaultAmount)} className="num pr-14" />
                <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">MUSD</span>
              </div>
            </Field>
          </div>
          {save.isError ? (
            <p role="alert" className="text-sm text-bad">
              {errorMessage(save.error)}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="recipient-form" disabled={save.isPending}>
            {save.isPending ? "Saving…" : recipient ? "Save changes" : "Add recipient"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
