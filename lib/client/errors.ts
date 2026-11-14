import { decodeErrorResult, formatUnits, parseAbi, type Hex } from "viem";
import { erc20Abi, organizationRegistryAbi, payrollEscrowAbi } from "@/lib/chain/abis";
import { CHAIN_PAYMENT_STATUS, CHAIN_RUN_STATUS, contracts } from "@/lib/chain/config";

/**
 * Turns wallet, RPC and contract errors into one plain sentence a person can act on.
 * Custom errors are decoded with the frozen ABIs; raw hex never reaches the screen.
 */
export type TxErrorKind = "rejected" | "network" | "revert" | "funds" | "rpc" | "unknown";
export interface TxError {
  kind: TxErrorKind;
  title: string;
  message: string;
  errorName?: string;
}

const RUN_STATUS_WORDS: Record<string, string> = {
  none: "not created",
  draft: "a draft",
  pending_approval: "waiting for approval",
  approved: "approved",
  funded: "funded",
  published: "published",
  cancelled: "cancelled",
  expired: "expired",
};
const PAYMENT_STATUS_WORDS: Record<string, string> = {
  none: "not found",
  allocated: "available",
  claimed: "already claimed",
  cancelled: "cancelled",
};
const ROLE_WORDS: Record<number, string> = { 1: "admin", 2: "approver", 3: "admin or approver", 4: "operator", 5: "operator or admin", 6: "operator or approver", 7: "operator, approver or admin" };

function date(sec: unknown): string {
  const n = typeof sec === "bigint" ? Number(sec) : Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "the deadline";
  return new Date(n * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function musd(v: unknown): string {
  try {
    return `${Number(formatUnits(BigInt(v as bigint), 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} MUSD`;
  } catch {
    return "the expected amount";
  }
}

type Args = readonly unknown[] | undefined;
const MESSAGES: Record<string, (a: Args) => string> = {
  // PayrollEscrow
  RunNotFound: () => "This payroll run does not exist on-chain.",
  PaymentNotFound: () => "This payment does not exist on-chain.",
  InvalidStatus: (a) => `The run is ${RUN_STATUS_WORDS[CHAIN_RUN_STATUS[Number(a?.[1] ?? 0)] ?? "none"] ?? "in another state"} on-chain, so this step isn't possible now. Refresh to see its latest state.`,
  NotAuthorized: (a) => {
    const role = ROLE_WORDS[Number(a?.[2] ?? 0)];
    return role ? `This needs the ${role} role, and the connected wallet doesn't have it in this organization.` : "The connected wallet doesn't have the role this needs in this organization.";
  },
  ApprovalsRevoked: (a) =>
    `Only ${String(a?.[1] ?? 0)} of the ${String(a?.[2] ?? "required")} approvals still count, because an approver lost the approver role after signing. Give that wallet the approver role again, or return the run to draft and collect new approvals.`,
  DuplicateRunRef: () => "This run was already created on-chain. Refresh the page to continue from where it stopped.",
  InvalidClaimWindow: () => "The claim window must be between 1 hour and 365 days.",
  EmptyBatch: () => "This batch has no payments.",
  BatchTooLarge: (a) => `A batch can hold at most ${String(a?.[1] ?? 100)} payments.`,
  LengthMismatch: () => "Each recipient needs exactly one amount.",
  IndexMismatch: () => "This batch was already added (or another batch went first). Refresh to load the next batch.",
  InvalidRecipient: (a) =>
    typeof a?.[0] === "string" && a[0].toLowerCase() === contracts.musd.toLowerCase()
      ? "One recipient is the MUSD token contract itself. Payments sent there would be lost, so it isn't allowed."
      : "One of the wallet addresses isn't allowed: it is empty, the escrow, or the MUSD token contract.",
  InvalidAmount: () => "Every amount must be above zero and fit the contract limit.",
  TooManyPayments: () => "A run can hold at most 5,000 payments.",
  EmptyRun: () => "Add at least one payment before submitting.",
  HashMismatch: () => "The payments on-chain changed since you reviewed them. Reload the run and review again before approving.",
  AlreadyApproved: () => "This wallet already approved this run.",
  NotRecipient: () => "Only the wallet this payment was sent to can claim it.",
  PaymentNotClaimable: (a) => `This payment is ${PAYMENT_STATUS_WORDS[CHAIN_PAYMENT_STATUS[Number(a?.[1] ?? 0)] ?? "none"] ?? "not claimable"}.`,
  ClaimWindowClosed: (a) => `The claim window closed on ${date(a?.[1])}, so this payment can't be claimed any more. Ask the sender about it.`,
  ClaimWindowOpen: (a) => `Recipients can still claim until ${date(a?.[1])}. You can expire the run after that.`,
  NothingToRefund: () => "There is nothing left to refund for this run.",
  FundingShortfall: (a) => `The escrow received less than expected (${musd(a?.[1])} of ${musd(a?.[0])}).`,
  OrgNotFound: () => "This organization does not exist on-chain yet.",
  EnforcedPause: () => "PayFlow is paused by its operator. Claims and new runs are on hold for now.",
  ExpectedPause: () => "PayFlow is not paused.",
  ReentrancyGuardReentrantCall: () => "Another transaction is in progress. Try again.",
  SafeERC20FailedOperation: () => "The MUSD transfer failed. Check your balance and approval.",
  // OrganizationRegistry
  NotOwner: () => "Only the organization owner can do this. Admins can only add or remove operators.",
  InvalidRoles: () => "Those roles are not allowed for this member.",
  InvalidMember: () => "That wallet address cannot be a member.",
  InvalidApprovals: () => "Approvals required must be between 1 and 10.",
  NotPendingOwner: () => "This wallet is not the pending owner.",
  AccessControlUnauthorizedAccount: () => "This wallet does not have permission for this action.",
  AccessControlBadConfirmation: () => "The role change was not confirmed by the right account.",
  // ERC20 / permit (OpenZeppelin)
  ERC20InsufficientAllowance: (a) =>
    a?.[1] !== undefined && a?.[2] !== undefined
      ? `PayFlow is allowed to move ${musd(a[1])}, but this needs ${musd(a[2])}. Allow MUSD again and retry.`
      : "PayFlow isn't allowed to move enough MUSD from this wallet. Allow MUSD again and retry.",
  ERC20InsufficientBalance: (a) =>
    a?.[1] !== undefined && a?.[2] !== undefined
      ? `This wallet has ${musd(a[1])}; this needs ${musd(a[2])}.`
      : "This wallet doesn't hold enough MUSD for this.",
  ERC2612ExpiredSignature: () => "The signature expired. Sign again.",
  ERC2612InvalidSigner: () => "The signature does not match this wallet. Sign again.",
};

/** OpenZeppelin v5 ERC-20 / permit errors, which MUSD may revert with but the generated ERC-20 ABI omits. */
export const OZ_TOKEN_ERRORS = parseAbi([
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC2612ExpiredSignature(uint256 deadline)",
  "error ERC2612InvalidSigner(address signer, address owner)",
]);

const ALL_ERRORS = [...payrollEscrowAbi, ...organizationRegistryAbi, ...erc20Abi, ...OZ_TOKEN_ERRORS].filter(
  (x) => (x as { type: string }).type === "error",
);

export function messageForError(name: string, args?: readonly unknown[]): string {
  const fn = MESSAGES[name];
  if (fn) return fn(args);
  return humanizeErrorName(name);
}

/** "ClaimWindowClosed" → "Claim window closed." */
export function humanizeErrorName(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/).filter(Boolean);
  if (!words.length) return "The contract rejected this transaction.";
  return `${words.map((w, i) => (i === 0 ? w : w.toLowerCase())).join(" ")}.`;
}

/** Decode raw revert data with every PayFlow ABI. Returns null when unknown. */
export function decodeRevertData(data: Hex): { errorName: string; args: readonly unknown[] } | null {
  try {
    const r = decodeErrorResult({ abi: ALL_ERRORS as never, data });
    return { errorName: r.errorName, args: (r.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

type Loose = {
  name?: string;
  code?: number | string;
  message?: string;
  shortMessage?: string;
  details?: string;
  reason?: string;
  data?: unknown;
  raw?: unknown;
  cause?: unknown;
};

function links(err: unknown): Loose[] {
  const out: Loose[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur) && out.length < 12) {
    seen.add(cur);
    out.push(cur as Loose);
    cur = (cur as Loose).cause;
  }
  return out;
}

function text(e: Loose) {
  return [e.shortMessage, e.details, e.message, e.reason].filter((s): s is string => typeof s === "string").join("\n");
}

const TITLES: Record<string, { title: string; kind?: TxErrorKind }> = {
  ERC20InsufficientBalance: { title: "Not enough MUSD", kind: "funds" },
  ERC20InsufficientAllowance: { title: "MUSD allowance too low", kind: "funds" },
  ApprovalsRevoked: { title: "Approvals no longer valid" },
  NotAuthorized: { title: "Missing role" },
  NotOwner: { title: "Owner only" },
  ClaimWindowClosed: { title: "Claim window closed" },
  ClaimWindowOpen: { title: "Claim window still open" },
  InvalidStatus: { title: "Not possible in this state" },
  HashMismatch: { title: "Payments changed" },
  InvalidRecipient: { title: "Wallet not allowed" },
  NotRecipient: { title: "Wrong wallet" },
  EnforcedPause: { title: "PayFlow is paused" },
};

const revert = (name: string, args?: readonly unknown[]): TxError => ({
  kind: TITLES[name]?.kind ?? "revert",
  title: TITLES[name]?.title ?? "The contract rejected this",
  message: messageForError(name, args),
  errorName: name,
});

/** Revert strings from older ERC-20s and RPC nodes, matched before the generic "insufficient funds" (gas) check. */
function fromRevertString(all: string): TxError | null {
  if (/transfer amount exceeds balance|ERC20InsufficientBalance|burn amount exceeds balance/i.test(all)) {
    return { kind: "funds", title: "Not enough MUSD", message: "This wallet doesn't hold enough MUSD for this. Add MUSD or fund from another admin wallet.", errorName: "ERC20InsufficientBalance" };
  }
  if (/transfer amount exceeds allowance|insufficient allowance|ERC20InsufficientAllowance/i.test(all)) {
    return { kind: "funds", title: "MUSD allowance too low", message: "PayFlow isn't allowed to move enough MUSD from this wallet. Allow MUSD again and retry.", errorName: "ERC20InsufficientAllowance" };
  }
  return null;
}

export function describeTxError(err: unknown): TxError {
  if (err == null) return { kind: "unknown", title: "Something went wrong", message: "Please try again." };
  if (typeof err === "string") return { kind: "unknown", title: "Something went wrong", message: err };
  const chain = links(err);

  for (const e of chain) {
    if (e.name === "WrongNetworkError" || e.name === "ChainMismatchError") {
      return { kind: "network", title: "Wrong network", message: "Switch your wallet to Mezo Testnet and try again." };
    }
    if (
      e.name === "UserRejectedRequestError" ||
      e.code === 4001 ||
      e.code === "ACTION_REJECTED" ||
      /user (rejected|denied)|rejected the request|request rejected|denied transaction signature/i.test(text(e))
    ) {
      return { kind: "rejected", title: "Cancelled in wallet", message: "You cancelled the request. Nothing was sent." };
    }
  }

  for (const e of chain) {
    const d = e.data as { errorName?: string; args?: readonly unknown[] } | undefined;
    if (d && typeof d === "object" && typeof d.errorName === "string") {
      if (d.errorName === "Error" && typeof d.args?.[0] === "string") {
        return fromRevertString(d.args[0]) ?? { kind: "revert", title: "The contract rejected this", message: d.args[0] };
      }
      if (d.errorName === "Panic") {
        return { kind: "revert", title: "The contract rejected this", message: "The contract hit an internal check." };
      }
      return revert(d.errorName, d.args);
    }
    for (const candidate of [e.raw, e.data]) {
      if (typeof candidate === "string" && /^0x[0-9a-fA-F]{8}/.test(candidate)) {
        const dec = decodeRevertData(candidate as Hex);
        if (dec) return revert(dec.errorName, dec.args);
      }
    }
  }

  const all = chain.map(text).join("\n");
  const hex = /0x[0-9a-fA-F]{8,}/.exec(all);
  if (hex) {
    const dec = decodeRevertData(hex[0] as Hex);
    if (dec) return revert(dec.errorName, dec.args);
  }
  const named = /(?:reverted with custom error|Error:)\s*'?([A-Z][A-Za-z0-9]+)\(/.exec(all);
  if (named && MESSAGES[named[1]]) return revert(named[1]);

  const str = fromRevertString(all);
  if (str) return str;
  if (/insufficient funds|exceeds balance|gas required exceeds/i.test(all)) {
    return { kind: "funds", title: "Not enough BTC for gas", message: "Add a little testnet BTC to this wallet to pay network fees." };
  }
  if (/nonce too low|replacement transaction underpriced|already known/i.test(all)) {
    return { kind: "rpc", title: "Another transaction is pending", message: "Wait for your wallet's pending transaction, then retry." };
  }
  if (/timeout|timed out|took too long/i.test(all)) {
    return { kind: "rpc", title: "Network is slow", message: "Mezo Testnet did not answer in time. Check the explorer before retrying." };
  }
  if (/fetch failed|failed to fetch|network error|HTTP request failed/i.test(all)) {
    return { kind: "rpc", title: "Can't reach Mezo Testnet", message: "Check your connection and retry." };
  }
  if (/chain mismatch|does not match the target chain/i.test(all)) {
    return { kind: "network", title: "Wrong network", message: "Switch your wallet to Mezo Testnet and try again." };
  }
  if (/not connected/i.test(all)) {
    return { kind: "unknown", title: "Wallet not connected", message: "Connect your wallet and try again." };
  }
  if (/reverted/i.test(all)) {
    return { kind: "revert", title: "The contract rejected this", message: "The transaction was reverted." };
  }
  const first = chain[0];
  const msg = first?.shortMessage || first?.message;
  return { kind: "unknown", title: "Something went wrong", message: msg && msg.length < 160 ? msg : "Please try again." };
}

/** True for "the RPC didn't answer" errors (timeouts, fetch failures), not for contract reverts. */
export function isRpcUnreachable(err: unknown): boolean {
  if (!err) return false;
  const d = describeTxError(err);
  return d.kind === "rpc" && d.title !== "Another transaction is pending";
}
