import Link from "next/link";
import { cn } from "@/lib/client/utils";

/** PayFlow mark: two stacked bars, the lower one offset, read as money moving forward. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-6", className)}>
      <rect width="24" height="24" rx="6" className="fill-foreground" />
      <rect x="5" y="7" width="10" height="4" rx="1.2" className="fill-background" />
      <rect x="9" y="13" width="10" height="4" rx="1.2" fill="var(--brand)" />
    </svg>
  );
}

export function Logo({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2 rounded-md font-semibold tracking-[-0.01em] outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground", className)}>
      <LogoMark />
      <span>PayFlow</span>
    </Link>
  );
}
