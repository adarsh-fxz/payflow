"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import type { PaymentCategory, PayrollRunDetail, Schedule, ScheduleInput } from "@/lib/api-types";
import { formatMusd, tryParseMusd, weiToDecimalString } from "@/lib/money";
import { api, errorMessage } from "@/lib/client/api";
import { CATEGORY_LABEL, formatDate, FREQUENCY_LABEL, WEEKDAYS } from "@/lib/client/format";
import { canOperate } from "@/lib/client/roles";
import { cn } from "@/lib/client/utils";
import { useRecipients, useSchedules } from "@/hooks/use-api";
import { useOrg } from "@/components/org/org-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader, Section } from "@/components/shared/page-header";
import { EmptyState, ErrorState } from "@/components/shared/empty-state";
import { StatusDot } from "@/components/shared/status-dot";
import { Musd } from "@/components/shared/money";
import { Field } from "@/components/shared/field";

function cadence(s: Schedule) {
  if (s.frequency === "monthly") return `Monthly on day ${s.dayOfMonth ?? 1}`;
  const day = s.weekday !== null ? WEEKDAYS[s.weekday] : "";
  return `${FREQUENCY_LABEL[s.frequency]}${day ? ` on ${day}` : ""}`;
}

export function SchedulesView() {
  const org = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useSchedules(org.id);
  const operator = canOperate(org.myRoles);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [open, setOpenRaw] = useState(false);
  const [openCount, setOpenCount] = useState(0);
  const setOpen = (v: boolean) => {
    if (v) setOpenCount((n) => n + 1);
    setOpenRaw(v);
  };

  const generate = useMutation({
    mutationFn: (s: Schedule) => api<{ run: PayrollRunDetail; skipped: { recipientId: string; reason: string }[] }>(`/api/orgs/${org.id}/schedules/${s.id}/generate`, { method: "POST", json: {} }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["api", "org", org.id] });
      toast.success("Draft run created", { description: res.skipped?.length ? `${res.skipped.length} inactive or removed recipients were left out.` : undefined });
      router.push(`/app/${org.slug}/runs/${res.run.id}`);
    },
    onError: (e) => toast.error("Couldn't create the draft", { description: errorMessage(e) }),
  });
  const toggle = useMutation({
    mutationFn: (s: Schedule) => api(`/api/orgs/${org.id}/schedules/${s.id}`, { method: "PATCH", json: { active: !s.active } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api", "org", org.id] }),
    onError: (e) => toast.error("Couldn't update", { description: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: (s: Schedule) => api(`/api/orgs/${org.id}/schedules/${s.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Schedule deleted");
      return qc.invalidateQueries({ queryKey: ["api", "org", org.id] });
    },
    onError: (e) => toast.error("Couldn't delete", { description: errorMessage(e) }),
  });

  const list = q.data ?? [];
  return (
    <>
      <PageHeader
        title="Schedules"
        description="Recurring payroll templates. On each date PayFlow creates a draft run for you to review; nothing is paid automatically."
        actions={
          operator ? (
            <Button
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              <Plus data-icon="inline-start" /> New schedule
            </Button>
          ) : null
        }
      />
      <Section>
        {q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : q.isLoading ? (
          <div className="space-y-3 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}</div>
        ) : list.length === 0 ? (
          <EmptyState
            title="No schedules yet"
            body="Set up monthly salaries or weekly contractor pay once. Each period you get a draft run to check, approve and fund."
            action={operator ? <Button onClick={() => setOpen(true)}>New schedule</Button> : null}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Schedule</TableHead>
                <TableHead className="hidden md:table-cell">Repeats</TableHead>
                <TableHead className="text-right">Recipients</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Next draft</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <p className="font-medium">{s.name}</p>
                    <p className="text-[0.8125rem] text-muted-foreground">{CATEGORY_LABEL[s.paymentCategory]}</p>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{cadence(s)}</TableCell>
                  <TableCell className="num text-right">{s.items.length}</TableCell>
                  <TableCell className="text-right"><Musd wei={s.totalWei} /></TableCell>
                  <TableCell className="text-muted-foreground">{s.active ? formatDate(s.nextRunAt) : "Paused"}</TableCell>
                  <TableCell><StatusDot tone={s.active ? "ok" : "idle"} label={s.active ? "Active" : "Paused"} /></TableCell>
                  <TableCell>
                    {operator ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.name}`}><MoreHorizontal /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem disabled={generate.isPending} onSelect={() => generate.mutate(s)}>Create draft now</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => { setEditing(s); setOpen(true); }}>Edit</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => toggle.mutate(s)}>{s.active ? "Pause" : "Resume"}</DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onSelect={() => confirm(`Delete "${s.name}"? Runs it already created stay.`) && remove.mutate(s)}>Delete</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      <ScheduleDialog key={`${editing?.id ?? "new"}-${openCount}`} orgId={org.id} open={open} onOpenChange={setOpen} schedule={editing} />
    </>
  );
}

function ScheduleDialog({ orgId, open, onOpenChange, schedule }: { orgId: string; open: boolean; onOpenChange: (v: boolean) => void; schedule: Schedule | null }) {
  const qc = useQueryClient();
  const recipients = useRecipients(open ? orgId : undefined, { status: "active", page: 1, pageSize: 200 });
  // state is initialised from `schedule`; the parent remounts this dialog (key) for each open
  const [name, setName] = useState(schedule?.name ?? "");
  const [category, setCategory] = useState<PaymentCategory>(schedule?.paymentCategory ?? "salary");
  const [frequency, setFrequency] = useState<Schedule["frequency"]>(schedule?.frequency ?? "monthly");
  const [dayOfMonth, setDayOfMonth] = useState(schedule?.dayOfMonth ?? 25);
  const [weekday, setWeekday] = useState(schedule?.weekday ?? 5);
  const [amounts, setAmounts] = useState<Map<string, string>>(() => new Map((schedule?.items ?? []).map((i) => [i.recipientId, weiToDecimalString(i.amount)])));
  const [search, setSearch] = useState("");

  const items = recipients.data?.items ?? [];
  const shown = items.filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()));
  const invalid = [...amounts.values()].some((a) => (tryParseMusd(a) ?? 0n) <= 0n);
  const total = [...amounts.values()].reduce((n, a) => n + (tryParseMusd(a) ?? 0n), 0n);
  const ready = name.trim() && amounts.size > 0 && !invalid;

  const save = useMutation({
    mutationFn: () => {
      const body: ScheduleInput = {
        name: name.trim(),
        paymentCategory: category,
        frequency,
        dayOfMonth: frequency === "monthly" ? dayOfMonth : null,
        weekday: frequency === "monthly" ? null : weekday,
        items: [...amounts.entries()].map(([recipientId, amount]) => ({ recipientId, amount })),
      };
      return schedule ? api(`/api/orgs/${orgId}/schedules/${schedule.id}`, { method: "PATCH", json: body }) : api(`/api/orgs/${orgId}/schedules`, { method: "POST", json: body });
    },
    onSuccess: async () => {
      toast.success(schedule ? "Schedule updated" : "Schedule created");
      await qc.invalidateQueries({ queryKey: ["api", "org", orgId] });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{schedule ? "Edit schedule" : "New schedule"}</DialogTitle>
          <DialogDescription>Each period PayFlow creates a draft run with these people and amounts.</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="sc-name">
              <Input id="sc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Monthly salaries" />
            </Field>
            <Field label="Type" htmlFor="sc-cat">
              <Select value={category} onValueChange={(v) => setCategory(v as PaymentCategory)}>
                <SelectTrigger id="sc-cat" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Repeats" htmlFor="sc-freq">
              <Select value={frequency} onValueChange={(v) => setFrequency(v as Schedule["frequency"])}>
                <SelectTrigger id="sc-freq" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {frequency === "monthly" ? (
              <Field label="Day of the month" htmlFor="sc-day" hint="1 to 28, so it exists in every month.">
                <Input id="sc-day" type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(Math.min(28, Math.max(1, Number(e.target.value) || 1)))} className="num" />
              </Field>
            ) : (
              <Field label="Day of the week" htmlFor="sc-wd">
                <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
                  <SelectTrigger id="sc-wd" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{WEEKDAYS.map((d, i) => <SelectItem key={d} value={String(i)}>{d}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            )}
          </div>
          <div className="min-w-0 rounded-md border">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search recipients" aria-label="Search recipients" className="h-8 pl-7" />
              </div>
              <span className="num shrink-0 text-[0.8125rem] text-muted-foreground">{amounts.size} chosen · {formatMusd(total)} MUSD</span>
            </div>
            <ul className="max-h-64 divide-y overflow-y-auto">
              {recipients.isLoading ? (
                <li className="p-3"><Skeleton className="h-5 w-full" /></li>
              ) : shown.length === 0 ? (
                <li className="p-3 text-sm text-muted-foreground">{items.length ? "No match." : "Add recipients to your directory first."}</li>
              ) : (
                shown.map((r) => {
                  const on = amounts.has(r.id);
                  const val = amounts.get(r.id) ?? "";
                  const bad = on && (tryParseMusd(val) ?? 0n) <= 0n;
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <Checkbox
                        checked={on}
                        aria-label={`Include ${r.name}`}
                        onCheckedChange={(v) =>
                          setAmounts((m) => {
                            const n = new Map(m);
                            if (v) n.set(r.id, r.defaultAmount ? weiToDecimalString(r.defaultAmount) : "");
                            else n.delete(r.id);
                            return n;
                          })
                        }
                      />
                      <span className="min-w-0 flex-1 truncate">{r.name}</span>
                      <input
                        value={val}
                        disabled={!on}
                        inputMode="decimal"
                        placeholder="Amount"
                        aria-label={`Amount for ${r.name}`}
                        aria-invalid={bad}
                        onChange={(e) => setAmounts((m) => new Map(m).set(r.id, e.target.value))}
                        className={cn("num h-8 w-32 rounded-md border bg-transparent px-2 text-right outline-none focus:border-ring focus:ring-3 focus:ring-ring/40 disabled:opacity-40", bad && "border-bad/60")}
                      />
                    </li>
                  );
                })
              )}
            </ul>
          </div>
          {save.isError ? <p role="alert" className="text-sm text-bad">{errorMessage(save.error)}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!ready || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : schedule ? "Save changes" : "Create schedule"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
