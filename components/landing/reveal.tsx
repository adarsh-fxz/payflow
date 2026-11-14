import type { ReactNode } from "react";
import { cn } from "@/lib/client/utils";

/**
 * Content is visible by default; a CSS scroll-driven rise (globals.css .reveal) plays where the
 * browser supports it and the user hasn't asked for reduced motion. No opacity fade, so nothing
 * is ever left washed out.
 */
export function Reveal({ children, className }: { children: ReactNode; delay?: number; className?: string }) {
  return <div className={cn("reveal", className)}>{children}</div>;
}
