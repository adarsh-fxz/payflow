"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { RECIPIENT_CSV_TEMPLATE, validateRecipientCsv } from "@/lib/csv/validate";
import { api, ApiClientError, errorMessage, saveText } from "@/lib/client/api";
import { cn } from "@/lib/client/utils";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CsvDropZone } from "@/components/csv/drop-zone";
import { IssueList } from "@/components/csv/issue-list";
import { Address } from "@/components/shared/address";

export function ImportDialog({ orgId, open, onOpenChange }: { orgId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const report = useMemo(() => (file ? validateRecipientCsv(file.text) : null), [file]);

  const imp = useMutation({
    mutationFn: () => api<Record<string, unknown>>(`/api/orgs/${orgId}/recipients/import`, { method: "POST", json: { csv: file!.text } }),
    onSuccess: async (res) => {
      const added = typeof res?.imported === "number" ? res.imported : 0;
      const updated = typeof res?.updated === "number" ? res.updated : 0;
      toast.success(`${added} added${updated ? `, ${updated} updated` : ""}`);
      await qc.invalidateQueries({ queryKey: ["api", "org", orgId] });
      setFile(null);
      onOpenChange(false);
    },
  });

  const fileErrors = report?.fileIssues.filter((i) => i.severity === "error") ?? [];
  const badRows = report?.rows.filter((r) => !r.valid) ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setFile(null);
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import recipients</DialogTitle>
          <DialogDescription>
            Columns: name, wallet_address (required), email, department, external_id, payment_category, payment_frequency, amount.
          </DialogDescription>
        </DialogHeader>

        {!file ? (
          <div className="space-y-3">
            <CsvDropZone onText={(text, name) => setFile({ text, name })} />
            <Button variant="outline" size="sm" onClick={() => saveText(RECIPIENT_CSV_TEMPLATE, "payflow-recipients-template.csv")}>
              <Download data-icon="inline-start" /> Download template
            </Button>
          </div>
        ) : report ? (
          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p>
                <span className="font-medium">{file.name}</span>
                <span className="num text-muted-foreground">
                  {" "}
                  · {report.totalRows} rows · {report.validRows} valid
                  {report.invalidRows ? ` · ${report.invalidRows} with errors` : ""}
                </span>
              </p>
              <button type="button" onClick={() => setFile(null)} className="cursor-pointer text-[0.8125rem] text-muted-foreground hover:text-foreground">
                Choose another file
              </button>
            </div>
            <IssueList issues={report.fileIssues} />
            {badRows.length ? (
              <div className="max-h-72 overflow-auto rounded-md border">
                <table className="w-full text-[0.8125rem]">
                  <thead className="sticky top-0 bg-surface text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Row</th>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Wallet</th>
                      <th className="px-3 py-2 font-medium">Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {badRows.map((r) => (
                      <tr key={r.row} className="border-t align-top">
                        <td className="num px-3 py-2">{r.row}</td>
                        <td className="px-3 py-2">{r.name || <span className="text-muted-foreground">empty</span>}</td>
                        <td className="px-3 py-2 font-mono">{r.walletAddress ? (r.issues.some((i) => i.column === "wallet_address") ? r.walletAddress.slice(0, 14) + "…" : <Address value={r.walletAddress} copy={false} link={false} />) : "empty"}</td>
                        <td className="px-3 py-2 text-bad">{r.issues.filter((i) => i.severity === "error").map((i) => i.message).join(". ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <p className={cn("text-sm", report.validRows ? "text-muted-foreground" : "text-bad")}>
              {report.validRows === 0
                ? "No rows can be imported. Fix the file and try again."
                : badRows.length
                  ? `Nothing is imported until every row is valid. Fix the ${badRows.length === 1 ? "row" : `${badRows.length} rows`} above in your file and upload it again.`
                  : `All ${report.validRows} rows look good.`}
            </p>
            {imp.isError ? (
              <p role="alert" className="text-sm text-bad">
                {errorMessage(imp.error)}
                {imp.error instanceof ApiClientError && imp.error.details && typeof imp.error.details === "object" && "invalidRows" in imp.error.details
                  ? ` (${String((imp.error.details as { invalidRows: number }).invalidRows)} rows with errors)`
                  : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={imp.isPending}>
            Cancel
          </Button>
          <Button onClick={() => imp.mutate()} disabled={!report || report.validRows === 0 || badRows.length > 0 || fileErrors.length > 0 || imp.isPending}>
            {imp.isPending ? "Importing…" : report?.validRows ? `Import ${report.validRows} ${report.validRows === 1 ? "recipient" : "recipients"}` : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
