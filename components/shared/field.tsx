import type { ReactNode } from "react";
import { cn } from "@/lib/client/utils";

/** Label above, control, hint, then error below. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  optional,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
      </label>
      {children}
      {hint && !error ? <p className="text-[0.8125rem] text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-[0.8125rem] text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
