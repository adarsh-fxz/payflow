"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { claimPath, parsePaymentRef } from "@/lib/client/claim-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PaymentLookup({ id: anchorId }: { id?: string }) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      id={anchorId}
      onSubmit={(e) => {
        e.preventDefault();
        const ref = parsePaymentRef(value);
        if (!ref) {
          setError("That doesn't look like a PayFlow claim link or payment ID.");
          return;
        }
        router.push(claimPath(ref));
      }}
      className="rounded-xl border bg-surface p-5 sm:p-6"
    >
      <label htmlFor={id} className="text-sm font-semibold">
        Were you sent a payment?
      </label>
      <p className="mt-1 text-sm text-muted-foreground">Paste the claim link or payment ID from your email.</p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder="https://…/claim/4294967296"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-err` : undefined}
          className="bg-background font-mono text-[0.8125rem]"
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" className="shrink-0">
          View a payment <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
      {error ? (
        <p id={`${id}-err`} className="mt-2 text-[0.8125rem] text-bad">
          {error}
        </p>
      ) : null}
    </form>
  );
}
