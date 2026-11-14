import type { ReactNode } from "react";
import { cn } from "@/lib/client/utils";

export function EmptyState({ title, body, action, className }: { title: string; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-start gap-2 px-4 py-10 sm:px-6", className)}>
      <p className="text-sm font-medium">{title}</p>
      {body ? <p className="max-w-[56ch] text-sm text-muted-foreground">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title = "Couldn't load this", message, onRetry, className }: { title?: string; message?: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-start gap-2 px-4 py-8 sm:px-6", className)}>
      <p className="text-sm font-medium">{title}</p>
      {message ? <p className="max-w-[60ch] text-sm text-muted-foreground">{message}</p> : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-1 cursor-pointer text-sm font-medium text-brand-ink underline-offset-4 hover:underline">
          Try again
        </button>
      ) : null}
    </div>
  );
}
