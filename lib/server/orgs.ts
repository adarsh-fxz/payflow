import "./guard";
import { keccak256, toBytes, type Hex } from "viem";
import { ALL_ROLES, contracts } from "../chain/config";
import type { Member, Organization, RecoverOrgResponse } from "../api-types";
import type { z } from "zod";
import type { Db } from "./db";
import { fail } from "./http";
import { canSetMemberRoles, loadOrg, rolesFor, type OrgAccess, type OrgRow } from "./authz";
import { orgDto, memberDto, type MemberRow } from "./dto";
import { audit } from "./audit";
import { assertSuccessfulCall, blockAtOrBefore, fetchOrgCreatedLogs, fetchReceipt, latestBlock, readRolesOf, requireDeployed } from "./chain";
import { activatePendingOrg, applyLogs, MAX_CHUNK } from "./indexer";
import type { createOrgSchema, updateOrgSchema, upsertMemberSchema } from "./schemas";

/** keccak256 of canonical JSON {name,slug,description,logoUrl} (fixed key order). */
export function orgMetadataHash(m: { name: string; slug: string; description: string; logoUrl: string | null }): Hex {
  return keccak256(toBytes(JSON.stringify({ name: m.name, slug: m.slug, description: m.description, logoUrl: m.logoUrl })));
}

export function slugify(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s || "org";
}

async function uniqueSlug(db: Db, name: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set((await db.query<{ slug: string }>(`SELECT slug FROM organizations WHERE slug = $1 OR slug LIKE $2`, [base, `${base}-%`])).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function listMyOrgs(db: Db, wallet: string): Promise<Organization[]> {
  const rows = await db.query<OrgRow & { my_roles: number | null }>(
    `SELECT o.*, CASE WHEN o.owner_wallet = $1 THEN ${ALL_ROLES} ELSE m.roles END AS my_roles
     FROM organizations o
     LEFT JOIN organization_members m ON m.organization_id = o.id AND m.wallet_address = $1 AND m.status = 'active'
     WHERE o.owner_wallet = $1 OR m.id IS NOT NULL
     ORDER BY o.created_at DESC`,
    [wallet],
  );
  return rows.map((r) => orgDto(r, Number(r.my_roles ?? 0)));
}

export async function createOrg(db: Db, wallet: string, input: Omit<z.infer<typeof createOrgSchema>, "email"> & { email?: string | null }): Promise<Organization> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = await uniqueSlug(db, input.name);
    const metadataHash = orgMetadataHash({ name: input.name, slug, description: input.description, logoUrl: input.logoUrl });
    const id = crypto.randomUUID();
    const rows = await db.query<OrgRow>(
      `INSERT INTO organizations (id, name, slug, description, logo_url, owner_wallet, treasury_wallet, metadata_hash, default_claim_window_days, status, owner_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10) ON CONFLICT (slug) DO NOTHING RETURNING *`,
      [id, input.name, slug, input.description, input.logoUrl, wallet, input.treasuryWallet, metadataHash, input.defaultClaimWindowDays, input.email ?? null],
    );
    if (rows[0]) {
      await audit(db, { orgId: id, actor: wallet, action: "org.create", resourceId: id, metadata: { name: input.name, slug, metadataHash } });
      return orgDto(rows[0], ALL_ROLES);
    }
  }
  throw fail("conflict", "Could not allocate a unique slug; try another name");
}

/** PATCH response: the Organization plus whether its on-chain metadataHash is now stale. */
export type UpdatedOrganization = Organization & {
  /** true when name/description/logo changed: an ADMIN must call OrganizationRegistry.setMetadata(chainOrgId, metadataHash)
   *  and then POST /api/orgs/:orgId/metadata/confirm { txHash }. Until then the on-chain hash is stale. */
  metadataChanged: boolean;
};

export async function updateOrg(db: Db, wallet: string, org: OrgRow, input: z.infer<typeof updateOrgSchema>): Promise<UpdatedOrganization> {
  const name = input.name ?? org.name;
  const description = input.description ?? org.description;
  const logoUrl = input.logoUrl !== undefined ? input.logoUrl : org.logo_url;
  const treasury = input.treasuryWallet !== undefined ? input.treasuryWallet : org.treasury_wallet;
  const days = input.defaultClaimWindowDays ?? Number(org.default_claim_window_days);
  const metadataHash = orgMetadataHash({ name, slug: org.slug, description, logoUrl });
  const metadataChanged = metadataHash.toLowerCase() !== org.metadata_hash.toLowerCase();
  // A pending org may already have a createOrganization tx carrying the old hash; changing it would
  // make that tx unmatchable (confirm/recover compare hashes).
  if (metadataChanged && org.status !== "active") {
    throw fail("conflict", "Finish registering the organization on-chain before changing its name, description or logo");
  }
  const rows = await db.query<OrgRow>(
    `UPDATE organizations SET name = $2, description = $3, logo_url = $4, treasury_wallet = $5, default_claim_window_days = $6, metadata_hash = $7
     WHERE id = $1 RETURNING *`,
    [org.id, name, description, logoUrl, treasury, days, metadataHash],
  );
  await audit(db, { orgId: org.id, actor: wallet, action: "org.update", resourceId: org.id, metadata: { ...input, metadataHash, metadataChanged } });
  return { ...orgDto(rows[0]!, await rolesFor(db, rows[0]!, wallet)), metadataChanged };
}

/** Verifies a setMetadata receipt for the org's CURRENT metadata hash and records it as on-chain. */
export async function confirmMetadata(db: Db, wallet: string, org: OrgRow, txHash: Hex): Promise<Organization> {
  requireDeployed();
  if (org.chain_org_id == null) throw fail("conflict", "Organization is not confirmed on-chain yet");
  const receipt = await fetchReceipt(txHash, { waitMs: 5_000 });
  assertSuccessfulCall(receipt, contracts.registry);
  const ev = receipt.logs.find((l) => l.eventName === "MetadataUpdated" && l.address === contracts.registry.toLowerCase() && String(l.args.orgId) === String(org.chain_org_id));
  if (!ev) throw fail("chain_mismatch", "Transaction did not update this organization's metadata");
  const hash = String(ev.args.metadataHash).toLowerCase();
  if (hash !== org.metadata_hash.toLowerCase()) {
    throw fail("chain_mismatch", "On-chain metadata hash does not match the organization's current settings", { expected: org.metadata_hash, actual: hash });
  }
  await applyLogs(db, receipt.logs);
  await db.query(`UPDATE organizations SET chain_metadata_hash = $2 WHERE id = $1`, [org.id, hash]);
  await audit(db, { orgId: org.id, actor: wallet, action: "org.metadata_confirm", resourceId: org.id, metadata: { txHash, metadataHash: hash } });
  const fresh = await loadOrg(db, org.id);
  return orgDto(fresh, await rolesFor(db, fresh, wallet));
}

/** A pending org older than this is worth an on-chain search (its confirm call may have been lost). */
export const RECOVER_AFTER_MS = 60_000;
export function recoverHint(org: OrgRow, now = Date.now()): boolean {
  return org.status !== "active" && org.chain_org_id == null && now - new Date(org.created_at).getTime() > RECOVER_AFTER_MS;
}

/**
 * POST /orgs/:id/recover: finds the owner's OrganizationCreated event whose metadataHash matches this
 * org (owner is an indexed topic), scanning from max(deploy block, ~the org's creation time) to head
 * in ≤5,000-block chunks, and activates the org with the EARLIEST unlinked match. Idempotent.
 */
export async function recoverOrg(db: Db, wallet: string, org: OrgRow, opts: { maxChunks?: number } = {}): Promise<RecoverOrgResponse> {
  requireDeployed();
  if (org.status === "active") return { recovered: false, organization: orgDto(org, ALL_ROLES), txHash: (org.create_tx_hash as Hex | null) ?? null };
  const head = await latestBlock();
  let from = contracts.deployBlock;
  if (head - from > MAX_CHUNK * 20n) {
    // Skip history before the org existed in our DB (minus 1h for clock skew between DB and chain).
    const start = await blockAtOrBefore(new Date(new Date(org.created_at).getTime() - 3_600_000), from, head);
    if (start > from) from = start;
  }
  const maxChunks = opts.maxChunks ?? 400;
  const want = org.metadata_hash.toLowerCase();
  let chunks = 0;
  for (let lo = from; lo <= head; lo += MAX_CHUNK) {
    if (++chunks > maxChunks) throw fail("conflict", "The search range is too large; contact support with your createOrganization transaction hash");
    const hi = lo + MAX_CHUNK - 1n > head ? head : lo + MAX_CHUNK - 1n;
    const logs = (await fetchOrgCreatedLogs(org.owner_wallet, lo, hi))
      .filter((l) => l.metadataHash === want && l.owner === org.owner_wallet)
      .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    for (const l of logs) {
      const linked = await db.query(`SELECT id FROM organizations WHERE chain_org_id = $1`, [l.orgId.toString()]);
      if (linked.length) continue; // that on-chain org already belongs to another PayFlow org
      const id = await activatePendingOrg(db, { orgId: l.orgId.toString(), owner: l.owner, metadataHash: l.metadataHash, txHash: l.txHash }, org.id);
      if (id) {
        await audit(db, { orgId: org.id, actor: wallet, action: "org.recover", resourceId: org.id, metadata: { txHash: l.txHash, chainOrgId: l.orgId.toString() } });
        return { recovered: true, organization: orgDto(await loadOrg(db, org.id), ALL_ROLES), txHash: l.txHash as Hex };
      }
    }
  }
  return { recovered: false, organization: orgDto(await loadOrg(db, org.id), ALL_ROLES), txHash: null };
}

/** Verifies the createOrganization receipt and activates the org. Idempotent. */
export async function confirmOrg(db: Db, wallet: string, org: OrgRow, txHash: Hex): Promise<Organization> {
  requireDeployed();
  if (org.status === "active" && org.create_tx_hash === txHash) return orgDto(org, ALL_ROLES);
  if (org.status === "active") throw fail("conflict", "Organization is already confirmed");
  const receipt = await fetchReceipt(txHash, { waitMs: 5_000 });
  assertSuccessfulCall(receipt, contracts.registry);
  const ev = receipt.logs.find((l) => l.eventName === "OrganizationCreated" && l.address === contracts.registry.toLowerCase());
  if (!ev) throw fail("chain_mismatch", "Transaction did not create an organization");
  const owner = String(ev.args.owner).toLowerCase();
  const hash = String(ev.args.metadataHash).toLowerCase();
  const chainOrgId = String(ev.args.orgId);
  if (owner !== wallet || owner !== org.owner_wallet) throw fail("chain_mismatch", "On-chain owner is not your wallet");
  if (hash !== org.metadata_hash.toLowerCase()) throw fail("chain_mismatch", "On-chain metadata hash does not match this organization", { expected: org.metadata_hash, actual: hash });
  const clash = await db.query<{ id: string }>(`SELECT id FROM organizations WHERE chain_org_id = $1`, [chainOrgId]);
  if (clash[0] && clash[0].id !== org.id) throw fail("conflict", "That on-chain organization is already linked to another organization");

  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE organizations SET chain_org_id = $2, status = 'active', create_tx_hash = $3, chain_metadata_hash = $4 WHERE id = $1 AND (chain_org_id IS NULL OR chain_org_id = $2)`,
      [org.id, chainOrgId, txHash, hash],
    );
    await tx.query(
      `INSERT INTO organization_members (id, organization_id, wallet_address, roles, status, tx_hash, email) VALUES ($1, $2, $3, $4, 'active', $5, $6)
       ON CONFLICT (organization_id, wallet_address) DO UPDATE SET roles = EXCLUDED.roles, status = 'active', tx_hash = EXCLUDED.tx_hash,
         email = COALESCE(organization_members.email, EXCLUDED.email)`,
      [crypto.randomUUID(), org.id, owner, ALL_ROLES, txHash, org.owner_email ?? null],
    );
  });
  await applyLogs(db, receipt.logs);
  await audit(db, { orgId: org.id, actor: wallet, action: "org.confirm", resourceId: org.id, metadata: { txHash, chainOrgId } });
  return orgDto(await loadOrg(db, org.id), ALL_ROLES);
}

export async function listMembers(db: Db, orgId: string): Promise<Member[]> {
  const rows = await db.query<MemberRow>(`SELECT * FROM organization_members WHERE organization_id = $1 ORDER BY (status = 'removed'), invited_at`, [orgId]);
  return rows.map(memberDto);
}

async function verifyMemberRolesTx(org: OrgRow, txHash: Hex, member: string, roles: number) {
  requireDeployed();
  if (org.chain_org_id == null) throw fail("conflict", "Organization is not confirmed on-chain yet");
  const receipt = await fetchReceipt(txHash, { waitMs: 5_000 });
  assertSuccessfulCall(receipt, contracts.registry);
  const ev = receipt.logs.find(
    (l) => l.eventName === "MemberRolesSet" && String(l.args.orgId) === String(org.chain_org_id) && String(l.args.member).toLowerCase() === member,
  );
  if (!ev) throw fail("chain_mismatch", "Transaction did not set roles for this member in this organization");
  if (Number(ev.args.roles) !== roles) throw fail("chain_mismatch", `On-chain roles (${Number(ev.args.roles)}) differ from the request (${roles})`);
  // Replay guard: an older tx must not override newer on-chain roles.
  const live = await readRolesOf(BigInt(org.chain_org_id), member);
  if (live !== roles) throw fail("chain_mismatch", `The member's current on-chain roles (${live}) differ from this transaction; it was superseded`);
  return receipt;
}

/** Same rule as OrganizationRegistry: admins manage OPERATOR only; ADMIN/APPROVER changes are owner-only. */
async function assertMayManage(db: Db, access: OrgAccess, member: string, newRoles: number): Promise<void> {
  const cur = await db.query<{ roles: number; status: string }>(`SELECT roles, status FROM organization_members WHERE organization_id = $1 AND wallet_address = $2`, [access.org.id, member]);
  const currentRoles = cur[0] && cur[0].status !== "removed" ? Number(cur[0].roles) : 0;
  if (!canSetMemberRoles(access, currentRoles, newRoles)) {
    throw fail("forbidden", "Only the owner can grant or remove the admin or approver role. Admins can manage operators only");
  }
}

export async function upsertMember(db: Db, wallet: string, access: OrgAccess, input: z.infer<typeof upsertMemberSchema>): Promise<Member> {
  const org = access.org;
  if (input.walletAddress === org.owner_wallet) throw fail("invalid_input", "The owner already holds every role");
  await assertMayManage(db, access, input.walletAddress, input.roles);
  const receipt = await verifyMemberRolesTx(org, input.txHash, input.walletAddress, input.roles);
  const rows = await db.query<MemberRow>(
    `INSERT INTO organization_members (id, organization_id, wallet_address, email, display_name, roles, status, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (organization_id, wallet_address) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name,
       roles = EXCLUDED.roles, status = EXCLUDED.status, tx_hash = EXCLUDED.tx_hash
     RETURNING *`,
    [crypto.randomUUID(), org.id, input.walletAddress, input.email, input.displayName, input.roles, input.roles === 0 ? "removed" : "active", input.txHash],
  );
  await applyLogs(db, receipt.logs);
  await audit(db, { orgId: org.id, actor: wallet, action: "member.set_roles", resourceId: rows[0]!.id, metadata: { member: input.walletAddress, roles: input.roles, txHash: input.txHash } });
  // Re-read: a later MemberRolesSet in the same tx (applied above) may have changed it.
  const fresh = await db.query<MemberRow>(`SELECT * FROM organization_members WHERE id = $1`, [rows[0]!.id]);
  return memberDto(fresh[0] ?? rows[0]!);
}

export async function removeMember(db: Db, wallet: string, access: OrgAccess, memberId: string, txHash: Hex): Promise<Member> {
  const org = access.org;
  const rows = await db.query<MemberRow>(`SELECT * FROM organization_members WHERE id = $1 AND organization_id = $2`, [memberId, org.id]);
  const m = rows[0];
  if (!m) throw fail("not_found", "Member not found");
  if (m.wallet_address === org.owner_wallet) throw fail("invalid_input", "The owner cannot be removed");
  await assertMayManage(db, access, m.wallet_address, 0);
  const receipt = await verifyMemberRolesTx(org, txHash, m.wallet_address, 0);
  const upd = await db.query<MemberRow>(`UPDATE organization_members SET roles = 0, status = 'removed', tx_hash = $2 WHERE id = $1 RETURNING *`, [m.id, txHash]);
  await applyLogs(db, receipt.logs);
  await audit(db, { orgId: org.id, actor: wallet, action: "member.remove", resourceId: m.id, metadata: { member: m.wallet_address, txHash } });
  return memberDto(upd[0]!);
}
