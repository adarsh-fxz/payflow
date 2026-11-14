"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { roleNames } from "@/lib/client/roles";
import { useOrgs } from "@/hooks/use-api";
import { errorMessage } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/shared/status-dot";
import { ErrorState } from "@/components/shared/empty-state";
import { CreateOrgForm } from "./create-org-form";

export function OrgPicker() {
  const orgs = useOrgs();
  const [creating, setCreating] = useState(false);
  const list = orgs.data ?? [];
  const showForm = creating || (orgs.isSuccess && list.length === 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      {showForm ? (
        <>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">Create an organization</h1>
          <p className="mt-2 max-w-[60ch] text-sm text-muted-foreground">
            An organization holds your recipients, payroll runs and team. Its owner and roles are recorded on Mezo; the name and details stay in PayFlow.
          </p>
          <div className="mt-8 rounded-lg border p-5 sm:p-6">
            <CreateOrgForm onCancel={list.length ? () => setCreating(false) : undefined} />
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-[-0.02em]">Your organizations</h1>
              <p className="mt-1 text-sm text-muted-foreground">Pick one to open its workspace.</p>
            </div>
            <Button onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" /> New organization
            </Button>
          </div>
          <div className="mt-6 overflow-hidden rounded-lg border">
            {orgs.isLoading ? (
              <div className="divide-y">
                {[0, 1].map((i) => (
                  <div key={i} className="flex items-center gap-4 px-4 py-4">
                    <Skeleton className="size-9 rounded-md" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
                ))}
              </div>
            ) : orgs.isError ? (
              <ErrorState message={errorMessage(orgs.error)} onRetry={() => void orgs.refetch()} />
            ) : (
              <ul className="divide-y">
                {list.map((o) => (
                  <li key={o.id}>
                    <Link href={`/app/${o.slug}`} className="group flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-muted/50">
                      <OrgAvatar name={o.name} logoUrl={o.logoUrl} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{o.name}</p>
                        <p className="truncate text-[0.8125rem] text-muted-foreground">{roleNames(o.myRoles).join(", ") || "Member"}</p>
                      </div>
                      <StatusDot tone={o.status === "active" ? "ok" : "warn"} label={o.status === "active" ? "On-chain" : "Not registered"} className="hidden text-[0.8125rem] sm:inline-flex" />
                      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function OrgAvatar({ name, logoUrl, size = "md" }: { name: string; logoUrl: string | null; size?: "sm" | "md" | "lg" }) {
  const cls = size === "sm" ? "size-7 text-xs" : size === "lg" ? "size-12 text-base" : "size-9 text-sm";
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt="" className={`${cls} shrink-0 rounded-md border bg-background object-cover`} />;
  }
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <span aria-hidden className={`${cls} inline-flex shrink-0 items-center justify-center rounded-md bg-secondary font-semibold text-secondary-foreground`}>
      {initials || "?"}
    </span>
  );
}
