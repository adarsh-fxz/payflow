import type { CsvIssue, CsvValidationReport, PaymentCategory, RunItemInput } from "@/lib/api-types";
import { parseCsv, PAYROLL_COLUMNS, validatePayrollCsv } from "@/lib/csv/validate";

/**
 * Pure state + gating for the payroll wizard (steps 1-4). Rows are kept as typed by the user and
 * re-validated with the same isomorphic validator the server runs on save.
 */
export interface DraftRow {
  /** Stable key for React lists and exclusion tracking. */
  key: string;
  recipientId: string | null;
  name: string;
  email: string;
  walletAddress: string;
  amount: string;
  description: string;
  department: string;
}

export const WIZARD_STEPS = [
  { key: "type", label: "Type" },
  { key: "recipients", label: "Recipients" },
  { key: "validate", label: "Check" },
  { key: "review", label: "Review" },
] as const;
export type WizardStepKey = (typeof WIZARD_STEPS)[number]["key"];

export interface WizardState {
  name: string;
  category: PaymentCategory | null;
  frequency: "one_time" | "monthly";
  rows: DraftRow[];
  excluded: ReadonlySet<string>;
  scheduledAt: string;
  claimWindowDays: number;
}

let seq = 0;
export function newRow(partial: Partial<Omit<DraftRow, "key">> = {}): DraftRow {
  seq += 1;
  return {
    key: `r${Date.now().toString(36)}${seq}`,
    recipientId: null,
    name: "",
    email: "",
    walletAddress: "",
    amount: "",
    description: "",
    department: "",
    ...partial,
  };
}

/** Plain RFC 4180 quoting, values kept verbatim (validation input, not an export). */
function cell(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

export function rowsToCsv(rows: DraftRow[]): string {
  const lines = [PAYROLL_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push([r.name, r.email, r.walletAddress, r.amount, r.description, r.department].map(cell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Parse an uploaded CSV into draft rows. File-level errors (missing columns etc.) block the import. */
export function rowsFromCsvText(text: string): { rows: DraftRow[]; fileErrors: CsvIssue[]; fileWarnings: CsvIssue[] } {
  const report = validatePayrollCsv(text);
  const fileErrors = report.fileIssues.filter((i) => i.severity === "error" && i.code !== "too_many_rows");
  const fileWarnings = report.fileIssues.filter((i) => i.severity === "warning" || i.code === "too_many_rows");
  if (fileErrors.length) return { rows: [], fileErrors, fileWarnings };
  // The validator returns email: null for an invalid address. Keep what the file actually says,
  // so the row is flagged invalid_email and stays editable instead of silently losing the value.
  const rawEmails = rawColumn(text, "email");
  const rows = report.rows.map((r, i) =>
    newRow({
      name: r.name,
      email: r.email ?? rawEmails[i] ?? "",
      walletAddress: r.walletAddress,
      amount: r.amount,
      description: r.description,
      department: r.department ?? "",
    }),
  );
  return { rows, fileErrors: [], fileWarnings };
}

/** Raw (trimmed) cell values of one column, one per data record, in file order. */
export function rawColumn(text: string, column: string): string[] {
  const parsed = parseCsv(text.replace(/^\uFEFF/, ""));
  const [header, ...data] = parsed.records;
  if (!header) return [];
  const idx = header.fields.findIndex((h) => h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s-]+/g, "_") === column);
  if (idx < 0) return data.map(() => "");
  return data.map((rec) => (rec.fields[idx] ?? "").trim());
}

export interface RowCheck {
  row: DraftRow;
  excluded: boolean;
  valid: boolean;
  /** Issues for this row (empty for excluded rows). */
  issues: CsvIssue[];
  amountWei: string | null;
}

export interface WizardValidation {
  report: CsvValidationReport;
  checks: RowCheck[];
  includedCount: number;
  excludedCount: number;
  blockingCount: number;
  warningCount: number;
}

/** Validate only the included rows (so excluding one duplicate clears the other) and map issues back. */
export function validateRows(rows: DraftRow[], excluded: ReadonlySet<string>, opts: { employerBalanceWei?: string } = {}): WizardValidation {
  const included = rows.filter((r) => !excluded.has(r.key));
  const report = validatePayrollCsv(rowsToCsv(included), { employerBalanceWei: opts.employerBalanceWei });
  const byKey = new Map<string, (typeof report.rows)[number]>();
  included.forEach((r, i) => {
    const rep = report.rows[i];
    if (rep) byKey.set(r.key, rep);
  });
  // Issue messages cite row numbers inside the included subset; rewrite them to the user's row numbers.
  const position = new Map(rows.map((r, i) => [r.key, i + 1]));
  const originalNo = new Map<number, number>();
  included.forEach((r, i) => originalNo.set(i + 1, position.get(r.key) ?? i + 1));
  const renumber = (m: string) => m.replace(/\brow (\d+)\b/gi, (all, d: string) => {
    const o = originalNo.get(Number(d));
    return o ? all.replace(d, String(o)) : all;
  });
  let blockingCount = 0;
  let warningCount = 0;
  const checks: RowCheck[] = rows.map((row) => {
    if (excluded.has(row.key)) return { row, excluded: true, valid: false, issues: [], amountWei: null };
    const rep = byKey.get(row.key);
    const issues = (rep?.issues ?? []).map((i) => ({ ...i, row: i.row ? (originalNo.get(i.row) ?? i.row) : i.row, message: renumber(i.message) }));
    const valid = rep?.valid ?? false;
    if (!valid) blockingCount++;
    if (issues.some((i) => i.severity === "warning")) warningCount++;
    return { row, excluded: false, valid, issues, amountWei: rep?.amountWei ?? null };
  });
  return {
    report,
    checks,
    includedCount: included.length,
    excludedCount: rows.length - included.length,
    blockingCount,
    warningCount,
  };
}

/** Whole-file problems that are not about a specific row (e.g. too many rows). */
export function blockingFileIssues(v: WizardValidation): CsvIssue[] {
  return v.report.fileIssues.filter((i) => i.severity === "error" && !(i.code === "empty_value" && v.includedCount > 0));
}

export const CLAIM_WINDOW_MIN_DAYS = 1;
export const CLAIM_WINDOW_MAX_DAYS = 365;

export type Gate = { ok: true } | { ok: false; reason: string };

/** Can the user leave `step` going forward? */
export function canAdvance(step: WizardStepKey, s: WizardState, v?: WizardValidation): Gate {
  switch (step) {
    case "type":
      if (!s.category) return { ok: false, reason: "Choose a payment type." };
      if (!s.name.trim()) return { ok: false, reason: "Give this run a name." };
      if (s.name.trim().length > 120) return { ok: false, reason: "Keep the name under 120 characters." };
      return { ok: true };
    case "recipients":
      if (s.rows.length === 0) return { ok: false, reason: "Add at least one recipient." };
      return { ok: true };
    case "validate": {
      if (!v) return { ok: false, reason: "Checking rows…" };
      if (v.includedCount === 0) return { ok: false, reason: "Every row is excluded. Include at least one." };
      const file = blockingFileIssues(v);
      if (file.length) return { ok: false, reason: file[0].message };
      if (v.blockingCount > 0) {
        return { ok: false, reason: `${v.blockingCount} ${v.blockingCount === 1 ? "row has" : "rows have"} errors. Fix or exclude ${v.blockingCount === 1 ? "it" : "them"} to continue.` };
      }
      return { ok: true };
    }
    case "review": {
      const d = s.claimWindowDays;
      if (!Number.isInteger(d) || d < CLAIM_WINDOW_MIN_DAYS || d > CLAIM_WINDOW_MAX_DAYS) {
        return { ok: false, reason: `Claim window must be ${CLAIM_WINDOW_MIN_DAYS} to ${CLAIM_WINDOW_MAX_DAYS} days.` };
      }
      if (!v || v.blockingCount > 0 || v.includedCount === 0) return { ok: false, reason: "Go back and fix the rows first." };
      return { ok: true };
    }
  }
}

/** The furthest step a user may jump to, given what is valid so far. */
export function maxReachableStep(s: WizardState, v?: WizardValidation): number {
  let i = 0;
  for (; i < WIZARD_STEPS.length - 1; i++) {
    if (!canAdvance(WIZARD_STEPS[i].key, s, v).ok) break;
  }
  return i;
}

/** Build the API payload from the included, valid rows. */
export function toRunItems(v: WizardValidation): RunItemInput[] {
  return v.checks
    .filter((c) => !c.excluded && c.valid)
    .map((c) => ({
      recipientId: c.row.recipientId,
      name: c.row.name.trim(),
      email: c.row.email.trim() || null,
      department: c.row.department.trim() || null,
      walletAddress: c.row.walletAddress.trim(),
      amount: c.row.amount.trim(),
      description: c.row.description.trim(),
    }));
}

/** "100 rows · 94 valid · 4 duplicate wallets · 2 invalid wallets" parts. */
export function summaryParts(v: WizardValidation): string[] {
  const r = v.report;
  const parts = [`${v.checks.length} ${v.checks.length === 1 ? "row" : "rows"}`, `${r.validRows} valid`];
  if (r.duplicateWallets) parts.push(`${r.duplicateWallets} duplicate ${r.duplicateWallets === 1 ? "wallet" : "wallets"}`);
  if (r.invalidWallets) parts.push(`${r.invalidWallets} invalid ${r.invalidWallets === 1 ? "wallet" : "wallets"}`);
  const otherInvalid = r.invalidRows - Math.min(r.invalidRows, r.duplicateWallets + r.invalidWallets);
  if (otherInvalid > 0) parts.push(`${otherInvalid} other ${otherInvalid === 1 ? "error" : "errors"}`);
  if (v.excludedCount) parts.push(`${v.excludedCount} excluded`);
  return parts;
}
