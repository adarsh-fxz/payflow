import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/client/utils";

/** One short rise for the hero copy (CSS only, skipped for reduced motion); always fully visible. */
export function HeroRise({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <div className={cn("hero-rise", className)} style={{ "--rise-delay": `${delay}s` } as CSSProperties}>
      {children}
    </div>
  );
}
