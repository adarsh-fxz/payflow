"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, MoreHorizontal, Plus, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import type { Paginated, Recipient, RecipientListQuery } from "@/lib/api-types";
import { api, errorMessage, saveText } from "@/lib/client/api";
import { toCsv } from "@/lib/csv/validate";
import { weiToDecimalString } from "@/lib/money";
import { checksum } from "@/lib/client/run-gates";
import { CATEGORY_LABEL, formatDate } from "@/lib/client/format";
import { canOperate } from "@/lib/client/roles";
import { useRecipients } from "@/hooks/use-api";
import { useOrg } from "@/components/org/org-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader, Section } from "@/components/shared/page-header";
import { EmptyState, ErrorState } from "@/components/shared/empty-state";
import { StatusDot } from "@/components/shared/status-dot";
import { Address } from "@/components/shared/address";
import { Musd } from "@/components/shared/money";
import { RecipientDialog } from "./recipient-dialog";
import { ImportDialog } from "./import-dialog";

const PAGE_SIZE = 25;

/** Export exactly what the current search and filters show (every page), wallets checksummed. */
async function exportFiltered(orgId: string, slug: string, q: Omit<RecipientListQuery, "page" | "pageSize">, filtered: boolean) {
  const all: Recipient[] = [];
  for (let page = 1; page <= 100; page++) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...q, page, pageSize: 200 })) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
    const res = await api<Paginated<Recipient> | Recipient[]>(`/api/orgs/${orgId}/recipients?${p}`);
    const items = Array.isArray(res) ? res : res.items;
    all.push(...items);
    const total = Array.isArray(res) ? items.length : res.total;
    if (Array.isArray(res) || items.length === 0 || all.length >= total) break;
  }
  const csv = toCsv(
    all.map((r) => ({
      name: r.name,
      email: r.email,
      wallet_address: checksum(r.walletAddress),
      amount: r.defaultAmount ? weiToDecimalString(r.defaultAmount) : "",
      department: r.department,
      external_id: r.externalId,
      payment_category: r.paymentCategory,
      payment_frequency: r.paymentFrequency,
      status: r.status,
      last_paid_at: r.lastPaidAt,
    })),
    ["name", "email", "wallet_address", "amount", "department", "external_id", "payment_category", "payment_frequency", "status", "last_paid_at"],
  );
  saveText(csv, `${slug}-recipients${filtered ? "-filtered" : ""}.csv`);
  return all.length;
}
const ALL = "__all";

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function RecipientsView() {
  const org = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const operator = canOperate(org.myRoles);

  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [department, setDepartment] = useState(ALL);
  const [status, setStatus] = useState<"active" | "inactive" | "all">("active");
  // page resets whenever the filters change (derived, no effect)
  const filterKey = `${q}|${department}|${status}`;
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;
  const setPage = (fn: (p: number) => number) => setPageState({ key: filterKey, page: fn(page) });
  const [editing, setEditing] = useState<Recipient | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(params.get("import") === "1");
  const [knownDepts, setKnownDepts] = useState<string[]>([]);


  const list = useRecipients(org.id, {
    q: q || undefined,
    department: department === ALL ? undefined : department,
    status,
    page,
    pageSize: PAGE_SIZE,
  });

  // Department options accumulate from every page seen, so the filter keeps its choices.
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const newDepts = items.map((r) => r.department).filter((d): d is string => Boolean(d) && !knownDepts.includes(d as string));
  if (newDepts.length) setKnownDepts(Array.from(new Set([...knownDepts, ...newDepts])).sort((a, b) => a.localeCompare(b)));

  const deactivate = useMutation({
    mutationFn: (r: Recipient) => api<unknown>(`/api/orgs/${org.id}/recipients/${r.id}`, { method: "DELETE" }),
    onSuccess: async (_d, r) => {
      toast.success(`${r.name} deactivated`);
      await qc.invalidateQueries({ queryKey: ["api", "org", org.id] });
    },
    onError: (e) => toast.error("Couldn't deactivate", { description: errorMessage(e) }),
  });
  const reactivate = useMutation({
    mutationFn: (r: Recipient) => api<unknown>(`/api/orgs/${org.id}/recipients/${r.id}`, { method: "PATCH", json: { status: "active" } }),
    onSuccess: async (_d, r) => {
      toast.success(`${r.name} is active again`);
      await qc.invalidateQueries({ queryKey: ["api", "org", org.id] });
    },
    onError: (e) => toast.error("Couldn't reactivate", { description: errorMessage(e) }),
  });

  // When the active list is empty, find out whether inactive recipients exist, to say so.
  const inactive = useRecipients(org.id, { status: "inactive", page: 1, pageSize: 1 });
  const inactiveCount = inactive.data?.total ?? 0;
  const [exporting, setExporting] = useState(false);
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(q) || department !== ALL || status !== "active";

  return (
    <>
      <PageHeader
        title="Recipients"
        description="People and wallets you pay. Saved recipients can be picked when you build a payroll run."
        actions={
          <>
            <Button
              variant="outline"
              disabled={exporting}
              title={filtered ? "Exports the recipients matching the current search and filters" : undefined}
              onClick={() => {
                setExporting(true);
                exportFiltered(org.id, org.slug, { q: q || undefined, department: department === ALL ? undefined : department, status }, filtered)
                  .then((n) => toast.success(`Exported ${n.toLocaleString()} ${n === 1 ? "recipient" : "recipients"}`))
                  .catch((e) => toast.error("Export failed", { description: errorMessage(e) }))
                  .finally(() => setExporting(false));
              }}
            >
              <Download data-icon="inline-start" /> {filtered ? "Export filtered" : "Export"}
            </Button>
            {operator ? (
              <>
                <Button variant="outline" onClick={() => setImportOpen(true)}>
                  <Upload data-icon="inline-start" /> Import CSV
                </Button>
                <Button
                  onClick={() => {
                    setEditing(null);
                    setDialogOpen(true);
                  }}
                >
                  <Plus data-icon="inline-start" /> Add recipient
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <Section>
        <div className="flex flex-col gap-2 border-b px-3 py-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email or wallet" aria-label="Search recipients" className="pl-8" />
          </div>
          <div className="flex gap-2">
            <Select value={department} onValueChange={setDepartment}>
              <SelectTrigger className="w-full sm:w-44" aria-label="Department">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All departments</SelectItem>
                {knownDepts.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger className="w-full sm:w-32" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="num text-[0.8125rem] text-muted-foreground sm:ml-auto">{list.data ? `${total.toLocaleString()} ${total === 1 ? "recipient" : "recipients"}` : ""}</p>
        </div>

        {list.isError ? (
          <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        ) : list.isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          filtered ? (
            <EmptyState title="No recipients match" body="Try a different search or filter." />
          ) : inactiveCount > 0 ? (
            <EmptyState
              title="No active recipients"
              body={`${inactiveCount.toLocaleString()} inactive ${inactiveCount === 1 ? "recipient is" : "recipients are"} hidden. Show them to reactivate, or add someone new.`}
              action={
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setStatus("inactive")}>
                    Show inactive
                  </Button>
                  {operator ? <Button onClick={() => setDialogOpen(true)}>Add recipient</Button> : null}
                </div>
              }
            />
          ) : (
            <EmptyState
              title="No recipients yet"
              body="Add people one by one, or import a CSV with their names and wallet addresses. You can also upload a CSV directly when you build a run."
              action={
                operator ? (
                  <div className="flex gap-2">
                    <Button onClick={() => setImportOpen(true)}>Import CSV</Button>
                    <Button variant="outline" onClick={() => setDialogOpen(true)}>
                      Add recipient
                    </Button>
                  </div>
                ) : null
              }
            />
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Wallet</TableHead>
                <TableHead className="hidden md:table-cell">Department</TableHead>
                <TableHead className="hidden lg:table-cell">Type</TableHead>
                <TableHead className="text-right">Default amount</TableHead>
                <TableHead className="hidden md:table-cell">Last paid</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => (
                <TableRow key={r.id} className={list.isPlaceholderData ? "opacity-60" : undefined}>
                  <TableCell className="max-w-56">
                    <p className="truncate font-medium">{r.name}</p>
                    {r.email ? <p className="truncate text-[0.8125rem] text-muted-foreground">{r.email}</p> : null}
                  </TableCell>
                  <TableCell>
                    <Address value={r.walletAddress} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{r.department ?? ""}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{r.paymentCategory ? CATEGORY_LABEL[r.paymentCategory] : ""}</TableCell>
                  <TableCell className="text-right">{r.defaultAmount ? <Musd wei={r.defaultAmount} /> : <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{r.lastPaidAt ? formatDate(r.lastPaidAt) : "Never"}</TableCell>
                  <TableCell>
                    <StatusDot tone={r.status === "active" ? "ok" : "idle"} label={r.status === "active" ? "Active" : "Inactive"} />
                  </TableCell>
                  <TableCell>
                    {operator ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem
                            onSelect={() => {
                              setEditing(r);
                              setDialogOpen(true);
                            }}
                          >
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => router.push(`/app/${org.slug}/runs/new?recipient=${r.id}`)}>Pay in a new run</DropdownMenuItem>
                          {r.status === "active" ? (
                            <DropdownMenuItem variant="destructive" onSelect={() => deactivate.mutate(r)}>
                              Deactivate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onSelect={() => reactivate.mutate(r)}>Reactivate</DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {pages > 1 ? (
          <div className="flex items-center justify-between border-t px-4 py-2.5 text-[0.8125rem]">
            <span className="num text-muted-foreground">
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Section>

      <RecipientDialog orgId={org.id} open={dialogOpen} onOpenChange={setDialogOpen} recipient={editing} />
      <ImportDialog orgId={org.id} open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
