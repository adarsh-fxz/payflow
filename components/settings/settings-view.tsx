"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { isAddress, type Address, type Hash, type Hex } from "viem";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useReadContract } from "wagmi";
import { toast } from "sonner";
import type { Member, Organization, UpdateOrgRequest, UpsertMemberRequest } from "@/lib/api-types";
import { organizationRegistryAbi } from "@/lib/chain/abis";
import { contracts, isDeployed, MEZO_TESTNET_ID, ROLE } from "@/lib/chain/config";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/client/format";
import { canAdmin, canManageMember, has, onlyOperator, roleNames } from "@/lib/client/roles";
import { build } from "@/lib/client/writes";
import { useMembers } from "@/hooks/use-api";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { useOrg } from "@/components/org/org-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader, Section } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/empty-state";
import { StatusDot } from "@/components/shared/status-dot";
import { Address as AddressText, TxLink } from "@/components/shared/address";
import { Field } from "@/components/shared/field";
import { TxStatus } from "@/components/shared/tx-status";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

export function SettingsView() {
  const org = useOrg();
  const admin = canAdmin(org.myRoles);
  const chainOrgId = org.chainOrgId ? BigInt(org.chainOrgId) : undefined;
  const onchain = useReadContract({
    address: contracts.registry,
    abi: organizationRegistryAbi,
    functionName: "getOrganization",
    args: chainOrgId !== undefined ? [chainOrgId] : undefined,
    chainId: MEZO_TESTNET_ID,
    query: { enabled: isDeployed && chainOrgId !== undefined },
  });

  return (
    <>
      <PageHeader title="Settings" description="Organization profile, team roles and approval rules." />
      <div className="space-y-6">
        <ProfileSection org={org} admin={admin} chainMetadataHash={onchain.data?.metadataHash as Hex | undefined} onChainRefetch={() => void onchain.refetch()} />
        <MembersSection org={org} admin={admin} />
        <ApprovalsSection key={onchain.data ? Number(onchain.data.approvalsRequired) : "loading"} org={org} current={onchain.data ? Number(onchain.data.approvalsRequired) : undefined} onDone={() => void onchain.refetch()} />
      </div>
    </>
  );
}

/* ---------------- profile ---------------- */

const profileSchema = z.object({
  name: z.string().trim().min(2, "Use at least 2 characters").max(80),
  description: z.string().trim().max(500),
  logoUrl: z.union([z.literal(""), z.string().trim().url("Enter a full https:// link")]),
  treasuryWallet: z.union([z.literal(""), z.string().trim().refine((v: string): boolean => isAddress(v), "Enter a valid 0x wallet address")]),
  defaultClaimWindowDays: z.number({ message: "Enter a number of days" }).int().min(1, "At least 1 day").max(365, "At most 365 days"),
});
type ProfileValues = z.infer<typeof profileSchema>;

function ProfileSection({ org, admin, chainMetadataHash, onChainRefetch }: { org: Organization; admin: boolean; chainMetadataHash?: Hex; onChainRefetch: () => void }) {
  const qc = useQueryClient();
  const w = useWallet();
  const tx = useTx();
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { name: org.name, description: org.description, logoUrl: org.logoUrl ?? "", treasuryWallet: org.treasuryWallet ?? "", defaultClaimWindowDays: org.defaultClaimWindowDays },
  });
  const save = useMutation({
    mutationFn: (v: ProfileValues) => {
      const body: UpdateOrgRequest = {
        name: v.name,
        description: v.description,
        logoUrl: v.logoUrl || null,
        treasuryWallet: (v.treasuryWallet ? v.treasuryWallet.toLowerCase() : null) as UpdateOrgRequest["treasuryWallet"],
        defaultClaimWindowDays: v.defaultClaimWindowDays,
      };
      return api<Organization>(`/api/orgs/${org.id}`, { method: "PATCH", json: body });
    },
    onSuccess: async (o) => {
      const changed = Boolean((o as Organization & { metadataChanged?: boolean }).metadataChanged);
      toast.success("Profile saved", changed ? { description: "Update the on-chain fingerprint below so recipients can verify it." } : undefined);
      form.reset({ name: o.name, description: o.description, logoUrl: o.logoUrl ?? "", treasuryWallet: o.treasuryWallet ?? "", defaultClaimWindowDays: o.defaultClaimWindowDays });
      await qc.invalidateQueries({ queryKey: ["api"] });
    },
  });
  const isOwner = w.address?.toLowerCase() === org.ownerWallet.toLowerCase();
  const stale = Boolean(chainMetadataHash && org.chainOrgId && chainMetadataHash.toLowerCase() !== org.metadataHash.toLowerCase());
  const e = form.formState.errors;

  return (
    <Section title="Organization profile" description="Shown to recipients on claim pages. Stored by PayFlow; a fingerprint of it is kept on-chain.">
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 p-4 sm:p-5" noValidate>
        <fieldset disabled={!admin} className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name" htmlFor="st-name" error={e.name?.message}>
              <Input id="st-name" {...form.register("name")} aria-invalid={Boolean(e.name)} />
            </Field>
            <Field label="Logo URL" htmlFor="st-logo" optional error={e.logoUrl?.message}>
              <Input id="st-logo" {...form.register("logoUrl")} aria-invalid={Boolean(e.logoUrl)} placeholder="https://…" />
            </Field>
          </div>
          <Field label="Description" htmlFor="st-desc" optional error={e.description?.message}>
            <Textarea id="st-desc" rows={2} {...form.register("description")} />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Treasury wallet" htmlFor="st-tr" optional error={e.treasuryWallet?.message}>
              <Input id="st-tr" {...form.register("treasuryWallet")} aria-invalid={Boolean(e.treasuryWallet)} className="font-mono text-[0.8125rem]" spellCheck={false} />
            </Field>
            <Field label="Default claim window (days)" htmlFor="st-win" error={e.defaultClaimWindowDays?.message}>
              <Input id="st-win" type="number" min={1} max={365} {...form.register("defaultClaimWindowDays", { valueAsNumber: true })} className="num" />
            </Field>
          </div>
        </fieldset>
        <dl className="grid gap-x-6 gap-y-1 text-[0.8125rem] sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Owner</dt>
          <dd><AddressText value={org.ownerWallet} /></dd>
          <dt className="text-muted-foreground">On-chain ID</dt>
          <dd className="num">{org.chainOrgId ?? "Not registered"}</dd>
          {org.createTxHash ? (
            <>
              <dt className="text-muted-foreground">Registered in</dt>
              <dd><TxLink hash={org.createTxHash} /></dd>
            </>
          ) : null}
        </dl>
        {save.isError ? <p role="alert" className="text-sm text-bad">{errorMessage(save.error)}</p> : null}
        {stale ? (
          <div className="rounded-md border border-warn/50 bg-warn/[0.06] px-3 py-2.5 text-sm">
            <p>The on-chain fingerprint is from an older version of this profile.</p>
            {isOwner || admin ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={tx.isBusy || !w.isReady}
                onClick={() =>
                  void tx
                    .run(build.setMetadata(BigInt(org.chainOrgId!), org.metadataHash), {
                      successMessage: "Fingerprint updated",
                      record: (hash: Hash) => api(`/api/orgs/${org.id}/metadata/confirm`, { method: "POST", json: { txHash: hash } }),
                    })
                    .then(onChainRefetch)
                }
              >
                Update on-chain fingerprint
              </Button>
            ) : null}
          </div>
        ) : null}
        <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} />
        {admin ? (
          <div>
            <Button type="submit" disabled={save.isPending || !form.formState.isDirty}>{save.isPending ? "Saving…" : "Save profile"}</Button>
          </div>
        ) : (
          <p className="text-[0.8125rem] text-muted-foreground">Only admins can edit the profile.</p>
        )}
      </form>
    </Section>
  );
}

/* ---------------- members ---------------- */

const ROLE_OPTIONS = [
  { bit: ROLE.OPERATOR, label: "Operator", body: "Builds runs and submits them for approval" },
  { bit: ROLE.APPROVER, label: "Approver", body: "Approves runs before they can be funded" },
  { bit: ROLE.ADMIN, label: "Admin", body: "Funds, publishes, cancels and refunds runs; adds operators" },
] as const;

function MembersSection({ org, admin }: { org: Organization; admin: boolean }) {
  const q = useMembers(org.id);
  const qc = useQueryClient();
  const w = useWallet();
  const tx = useTx();
  const isOwner = w.address?.toLowerCase() === org.ownerWallet.toLowerCase();
  const [editing, setEditing] = useState<{ wallet: string; roles: number; email: string; displayName: string; existing?: Member } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const chainReady = isDeployed && org.status === "active" && Boolean(org.chainOrgId);

  async function saveMember() {
    if (!editing || !org.chainOrgId) return;
    setFormError(null);
    const wallet = editing.wallet.trim();
    if (!isAddress(wallet)) return setFormError("Enter a valid 0x wallet address.");
    if (editing.roles === 0) return setFormError("Pick at least one role.");
    if (!isOwner && !onlyOperator(editing.roles)) return setFormError("Only the owner can grant the admin or approver role. Admins can add or remove operators.");
    const res = await tx.run(build.setMemberRoles(BigInt(org.chainOrgId), wallet as Address, editing.roles), {
      record: (hash: Hash) => {
        const body: UpsertMemberRequest = {
          walletAddress: wallet.toLowerCase() as Hex,
          roles: editing.roles,
          email: editing.email.trim() || null,
          displayName: editing.displayName.trim() || null,
          txHash: hash,
        };
        return api(`/api/orgs/${org.id}/members`, { method: "POST", json: body });
      },
      successMessage: editing.existing ? "Roles updated" : "Member added",
    });
    await qc.invalidateQueries({ queryKey: ["api", "org", org.id] });
    if (res?.recorded) setEditing(null);
  }

  async function removeMember(m: Member) {
    if (!org.chainOrgId) return;
    await tx.run(build.setMemberRoles(BigInt(org.chainOrgId), m.walletAddress as Address, 0), {
      record: (hash: Hash) => api(`/api/orgs/${org.id}/members/${m.id}?txHash=${hash}`, { method: "DELETE" }),
      successMessage: "Member removed",
    });
    await qc.invalidateQueries({ queryKey: ["api", "org", org.id] });
  }

  const members = (q.data ?? []).filter((m) => m.status !== "removed");

  return (
    <Section
      title="Members and roles"
      description={isOwner ? "Roles are set on-chain, so each change is a transaction from your wallet." : "Roles are set on-chain. Only the owner can grant or remove admin and approver roles; admins can add and remove operators."}
      actions={admin && chainReady && !editing ? <Button size="sm" onClick={() => setEditing({ wallet: "", roles: ROLE.OPERATOR, email: "", displayName: "" })}>Add member</Button> : null}
    >
      {!chainReady ? <p className="border-b px-4 py-2.5 text-[0.8125rem] text-muted-foreground">Register the organization on-chain to manage members.</p> : null}
      {editing ? (
        <div className="grid gap-4 border-b bg-surface p-4 sm:p-5">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Wallet address" htmlFor="mb-wallet" className="md:col-span-1">
              <Input id="mb-wallet" value={editing.wallet} disabled={Boolean(editing.existing)} onChange={(e) => setEditing({ ...editing, wallet: e.target.value })} placeholder="0x…" className="font-mono text-[0.8125rem]" spellCheck={false} />
            </Field>
            <Field label="Name" htmlFor="mb-name" optional>
              <Input id="mb-name" value={editing.displayName} onChange={(e) => setEditing({ ...editing, displayName: e.target.value })} />
            </Field>
            <Field label="Email" htmlFor="mb-email" optional hint="For notifications.">
              <Input id="mb-email" type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
            </Field>
          </div>
          <fieldset>
            <legend className="text-sm font-medium">Roles</legend>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              {ROLE_OPTIONS.map((r) => {
                const disabled = r.bit !== ROLE.OPERATOR && !isOwner;
                return (
                  <label key={r.bit} className={`flex items-start gap-2.5 rounded-md border bg-background px-3 py-2.5 ${disabled ? "opacity-60" : "cursor-pointer"}`}>
                    <Checkbox
                      className="mt-0.5"
                      disabled={disabled}
                      checked={has(editing.roles, r.bit)}
                      onCheckedChange={(v) => setEditing({ ...editing, roles: v ? editing.roles | r.bit : editing.roles & ~r.bit })}
                    />
                    <span>
                      <span className="block text-sm font-medium">{r.label}</span>
                      <span className="block text-[0.8125rem] text-muted-foreground">{disabled ? "Only the owner can grant this" : r.body}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          {formError ? <p role="alert" className="text-sm text-bad">{formError}</p> : null}
          <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} />
          <div className="flex gap-2">
            <Button disabled={tx.isBusy || !w.isReady} onClick={() => void saveMember()}>{editing.existing ? "Save roles" : "Add member"}</Button>
            <Button variant="ghost" disabled={tx.isBusy} onClick={() => { setEditing(null); tx.reset(); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <TxStatus state={tx.state} onRetryRecord={tx.retryRecord} className="m-3" />
      )}
      {q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <div className="space-y-3 p-4"><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-2/3" /></div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Member</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead className="hidden md:table-cell">Added</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-32"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>
                <p className="font-medium">Owner</p>
                <AddressText value={org.ownerWallet} />
              </TableCell>
              <TableCell>All roles</TableCell>
              <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(org.createdAt)}</TableCell>
              <TableCell><StatusDot tone="ok" label="Active" /></TableCell>
              <TableCell />
            </TableRow>
            {members.filter((m) => m.walletAddress.toLowerCase() !== org.ownerWallet.toLowerCase()).map((m) => {
              const canEdit = chainReady && canManageMember({ isOwner, admin, memberRoles: m.roles });
              return (
                <TableRow key={m.id}>
                  <TableCell>
                    {m.displayName ? <p className="font-medium">{m.displayName}</p> : null}
                    <AddressText value={m.walletAddress} />
                    {m.email ? <p className="text-[0.8125rem] text-muted-foreground">{m.email}</p> : null}
                  </TableCell>
                  <TableCell>{roleNames(m.roles).join(", ") || "None"}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(m.invitedAt)}</TableCell>
                  <TableCell><StatusDot tone={m.status === "active" ? "ok" : "warn"} label={m.status === "active" ? "Active" : "Pending"} /></TableCell>
                  <TableCell className="text-right">
                    {canEdit ? (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditing({ wallet: m.walletAddress, roles: m.roles, email: m.email ?? "", displayName: m.displayName ?? "", existing: m })}>Edit</Button>
                        <Button variant="ghost" size="sm" className="text-bad" disabled={tx.isBusy} onClick={() => setRemoving(m)}>Remove</Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={`Remove ${removing?.displayName ?? "this member"}?`}
        description={`They lose every role in ${org.name}. This is a transaction from your wallet.`}
        confirmLabel="Remove member"
        destructive
        onConfirm={() => {
          const m = removing;
          setRemoving(null);
          if (m) void removeMember(m);
        }}
      >
        {removing ? <p className="font-mono text-[0.8125rem] break-all">{removing.walletAddress}</p> : null}
      </ConfirmDialog>
    </Section>
  );
}

/* ---------------- approvals ---------------- */

function ApprovalsSection({ org, current, onDone }: { org: Organization; current?: number; onDone: () => void }) {
  const w = useWallet();
  const tx = useTx();
  const [value, setValue] = useState<number>(current ?? 1);
  const isOwner = w.address?.toLowerCase() === org.ownerWallet.toLowerCase();
  const chainReady = isDeployed && org.status === "active" && Boolean(org.chainOrgId);
  // setApprovalsRequired is owner-only on-chain.
  const can = chainReady && isOwner;

  return (
    <Section title="Approvals required" description="How many different approvers must sign before a run can be funded. Counted when a run is submitted.">
      <div className="flex flex-wrap items-end gap-3 p-4 sm:p-5">
        <Field label="Approvers needed" htmlFor="ap-n" className="w-40">
          <Input id="ap-n" type="number" min={1} max={10} value={value} disabled={!can} onChange={(e) => setValue(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} className="num" />
        </Field>
        <p className="pb-2 text-[0.8125rem] text-muted-foreground">
          {current === undefined ? (chainReady ? "Reading current setting…" : "Available after on-chain registration.") : `Currently ${current} on-chain.`}
          {chainReady && !isOwner ? " Only the owner can change it." : ""}
        </p>
        {can ? (
          <Button
            className="mb-0.5"
            disabled={tx.isBusy || value === current || !w.isReady}
            onClick={() => void tx.run(build.setApprovalsRequired(BigInt(org.chainOrgId!), value), { successMessage: "Approval rule updated" }).then(onDone)}
          >
            Save
          </Button>
        ) : null}
        <TxStatus state={tx.state} className="w-full" />
      </div>
    </Section>
  );
}
