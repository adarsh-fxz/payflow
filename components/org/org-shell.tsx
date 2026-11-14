"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { CalendarClock, ChevronsUpDown, FileText, LayoutDashboard, Settings, Users, Wallet } from "lucide-react";
import { errorMessage } from "@/lib/client/api";
import { roleNames } from "@/lib/client/roles";
import { cn } from "@/lib/client/utils";
import { useOrgBySlug, useOrgs } from "@/hooks/use-api";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { WalletButton } from "@/components/wallet/wallet-button";
import { AuthGate } from "@/components/wallet/auth-gate";
import { NotificationsBell } from "@/components/shared/notifications-bell";
import { ErrorState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OrgProvider } from "./org-context";
import { OrgAvatar } from "./org-picker";
import { RegisterOrgBanner } from "./register-org";

const NAV = [
  { href: "", label: "Dashboard", icon: LayoutDashboard },
  { href: "/runs", label: "Payroll runs", icon: Wallet },
  { href: "/recipients", label: "Recipients", icon: Users },
  { href: "/schedules", label: "Schedules", icon: CalendarClock },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function OrgWorkspace({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <AuthGate title="Sign in to open this workspace">
      <Workspace slug={slug}>{children}</Workspace>
    </AuthGate>
  );
}

function Workspace({ slug, children }: { slug: string; children: ReactNode }) {
  const { org, isLoading, error, notFound, refetch } = useOrgBySlug(slug);
  const pathname = usePathname();
  const router = useRouter();
  const base = `/app/${slug}`;

  // /app/<orgId>/… (e.g. from a notification) → canonical /app/<slug>/…
  useEffect(() => {
    if (org && org.slug !== slug && org.id === slug) router.replace(pathname.replace(`/app/${slug}`, `/app/${org.slug}`) + window.location.search);
  }, [org, slug, pathname, router]);

  if (isLoading) {
    return (
      <div className="flex flex-1">
        <aside className="hidden w-60 shrink-0 border-r bg-surface p-4 lg:block">
          <Skeleton className="h-8 w-36" />
          <div className="mt-8 space-y-3">
            {NAV.map((n) => (
              <Skeleton key={n.label} className="h-5 w-32" />
            ))}
          </div>
        </aside>
        <div className="flex-1 p-6">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="mt-6 h-40 w-full" />
        </div>
      </div>
    );
  }
  if (notFound || !org) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-20">
        {error ? (
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
        ) : (
          <>
            <h1 className="text-xl font-semibold">Organization not found</h1>
            <p className="mt-2 text-sm text-muted-foreground">It doesn&apos;t exist, or this wallet isn&apos;t a member.</p>
            <Button asChild variant="outline" className="mt-6">
              <Link href="/app">Back to your organizations</Link>
            </Button>
          </>
        )}
      </div>
    );
  }

  const isActive = (href: string) => (href === "" ? pathname === base : pathname === base + href || pathname.startsWith(base + href + "/"));

  return (
    <OrgProvider org={org}>
      <div className="flex min-h-dvh flex-1">
        {/* The column carries the background and border for the full page height; the inner aside sticks. */}
        <div className="hidden w-60 shrink-0 self-stretch border-r bg-surface lg:block">
        <aside className="sticky top-0 flex h-dvh flex-col">
          <div className="flex h-14 items-center px-4">
            <Logo href="/app" />
          </div>
          <div className="px-3">
            <OrgSwitcher currentSlug={slug} />
          </div>
          <nav aria-label="Workspace" className="mt-4 flex flex-col gap-0.5 px-3">
            {NAV.map((n) => {
              const active = isActive(n.href);
              return (
                <Link
                  key={n.label}
                  href={base + n.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    active ? "bg-background font-medium text-foreground shadow-[0_0_0_1px_var(--border)]" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <n.icon className={cn("size-4", active && "text-brand-ink")} strokeWidth={1.75} />
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto border-t px-4 py-3 text-xs text-muted-foreground">
            Mezo Testnet · chain 31611
          </div>
        </aside>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-[var(--z-sticky)] border-b bg-background/95 backdrop-blur-sm">
            <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-2 lg:hidden">
                <Logo href="/app" className="[&>span]:hidden sm:[&>span]:inline" />
                <span className="text-muted-foreground">/</span>
                <OrgSwitcher currentSlug={slug} compact />
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                <NotificationsBell />
                <ThemeToggle />
                <WalletButton />
              </div>
            </div>
            <nav aria-label="Workspace" className="flex gap-1 overflow-x-auto border-t px-3 py-1.5 lg:hidden">
              {NAV.map((n) => {
                const active = isActive(n.href);
                return (
                  <Link
                    key={n.label}
                    href={base + n.href}
                    aria-current={active ? "page" : undefined}
                    className={cn("shrink-0 rounded-md px-2.5 py-1 text-sm", active ? "bg-muted font-medium" : "text-muted-foreground")}
                  >
                    {n.label}
                  </Link>
                );
              })}
            </nav>
          </header>
          {org.status !== "active" ? <RegisterOrgBanner org={org} /> : null}
          <main id="main" className="w-full max-w-[1200px] flex-1 px-4 py-6 sm:px-6 sm:py-8">
            {children}
          </main>
        </div>
      </div>
    </OrgProvider>
  );
}

function OrgSwitcher({ currentSlug, compact = false }: { currentSlug: string; compact?: boolean }) {
  const orgs = useOrgs();
  const current = orgs.data?.find((o) => o.slug === currentSlug);
  if (!current) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-2 rounded-md text-left transition-colors hover:bg-muted",
            compact ? "px-1.5 py-1" : "w-full border bg-background px-2 py-1.5",
          )}
        >
          {!compact ? <OrgAvatar name={current.name} logoUrl={current.logoUrl} size="sm" /> : null}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{current.name}</span>
            {!compact ? <span className="block truncate text-xs text-muted-foreground">{roleNames(current.myRoles).join(", ") || "Member"}</span> : null}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Organizations</DropdownMenuLabel>
        {(orgs.data ?? []).map((o) => (
          <DropdownMenuItem key={o.id} asChild>
            <Link href={`/app/${o.slug}`} className={cn(o.slug === currentSlug && "font-medium")}>
              <OrgAvatar name={o.name} logoUrl={o.logoUrl} size="sm" />
              <span className="truncate">{o.name}</span>
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/app">All organizations</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
