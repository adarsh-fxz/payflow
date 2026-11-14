import { formatMusd } from "@/lib/money";
import { cn } from "@/lib/client/utils";

/** MUSD amount with tabular figures. `unit` appends " MUSD". */
export function Musd({
  wei,
  unit = true,
  decimals,
  compact,
  className,
}: {
  wei: string | bigint | null | undefined;
  unit?: boolean;
  decimals?: number;
  compact?: boolean;
  className?: string;
}) {
  if (wei === null || wei === undefined || wei === "") return <span className={cn("num text-muted-foreground", className)}>-</span>;
  let text: string;
  try {
    text = formatMusd(wei, { decimals, compact });
  } catch {
    text = "-";
  }
  return (
    <span className={cn("num whitespace-nowrap", className)}>
      {text}
      {unit ? <span className="text-muted-foreground"> MUSD</span> : null}
    </span>
  );
}
