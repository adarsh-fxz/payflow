import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { WalletButton } from "@/components/wallet/wallet-button";
import { NotificationsBell } from "@/components/shared/notifications-bell";

export function SiteHeader({ minimal = false }: { minimal?: boolean }) {
  return (
    <header className="sticky top-0 z-[var(--z-sticky)] border-b bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Logo />
        {!minimal ? (
          <nav aria-label="Main" className="ml-4 hidden items-center gap-5 text-sm text-muted-foreground md:flex">
            <Link href="/#how" className="hover:text-foreground">How it works</Link>
            <Link href="/#safety" className="hover:text-foreground">Safety</Link>
            <Link href="/payments" className="hover:text-foreground">My payments</Link>
            <Link href="/app" className="hover:text-foreground">Organizations</Link>
          </nav>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <NotificationsBell />
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
