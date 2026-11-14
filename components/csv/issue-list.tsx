import type { CsvIssue } from "@/lib/api-types";
import { cn } from "@/lib/client/utils";

export function IssueList({ issues, className }: { issues: CsvIssue[]; className?: string }) {
  if (!issues.length) return null;
  return (
    <ul className={cn("space-y-1 text-[0.8125rem]", className)}>
      {issues.map((i, n) => (
        <li key={n} className={i.severity === "error" ? "text-bad" : "text-muted-foreground"}>
          {i.row ? <span className="num">Row {i.row}: </span> : null}
          {i.message}
          {i.severity === "warning" ? " (warning)" : ""}
        </li>
      ))}
    </ul>
  );
}
