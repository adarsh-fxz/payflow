// Payroll / recipient CSV validation. Isomorphic: runs in the browser (instant wizard feedback)
// and on the server (re-validation on save). No node-only imports.
//
// Guarantees: every data row appears in the report with its issues (never silently dropped);
// wallet addresses are checksum-normalized when valid; amounts are parsed exactly into wei.
import { getAddress } from "viem";
import type { CsvIssue, CsvIssueCode, CsvRow, CsvValidationReport, PaymentCategory, PaymentFrequency } from "../api-types";
import { MoneyParseError, parseMusd, UINT128_MAX } from "../money";
import { contracts } from "../chain/config";

export const CSV_MAX_BYTES = 1024 * 1024;
export const CSV_MAX_ROWS = 5000;
export const DEFAULT_MAX_AMOUNT = "1000000";

export const PAYROLL_COLUMNS = ["name", "email", "wallet_address", "amount", "description", "department"] as const;
export const PAYROLL_REQUIRED = ["name", "wallet_address", "amount"] as const;
export const RECIPIENT_COLUMNS = [
  "name", "email", "wallet_address", "amount", "description", "department",
  "external_id", "payment_category", "payment_frequency",
] as const;
export const RECIPIENT_REQUIRED = ["name", "wallet_address"] as const;

export const PAYMENT_CATEGORIES: readonly PaymentCategory[] = ["salary", "contractor", "bounty", "reward", "grant", "custom"];
export const PAYMENT_FREQUENCIES: readonly PaymentFrequency[] = ["one_time", "weekly", "biweekly", "monthly"];

/** Example rows use a placeholder wallet on purpose: an unedited template cannot pay anyone. */
export const PAYROLL_CSV_TEMPLATE =
  "name,email,wallet_address,amount,description,department\r\n" +
  "Jane Doe,jane@example.com,0xReplaceWithRecipientWallet,1500.00,October salary,Engineering\r\n";

export const RECIPIENT_CSV_TEMPLATE =
  "name,email,wallet_address,amount,description,department,external_id,payment_category,payment_frequency\r\n" +
  "Jane Doe,jane@example.com,0xReplaceWithRecipientWallet,1500.00,,Engineering,EMP-001,salary,monthly\r\n";

export interface CsvValidateOptions {
  maxRows?: number;
  /** Human MUSD; default 1,000,000. */
  maxAmount?: string;
  employerBalanceWei?: string;
}

// ---------------------------------------------------------------------------------------------
// Low-level parsing (RFC 4180: quoted fields, "" escapes, CRLF/LF, newlines inside quotes)
// ---------------------------------------------------------------------------------------------

export interface ParsedCsv {
  records: { line: number; fields: string[] }[];
  error: string | null;
}

export function parseCsv(text: string): ParsedCsv {
  const records: { line: number; fields: string[] }[] = [];
  let field = "";
  let fields: string[] = [];
  let inQuotes = false;
  let quotedField = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const n = text.length;

  const endField = () => {
    fields.push(quotedField ? field : field.trim());
    field = "";
    quotedField = false;
  };
  const endRecord = () => {
    endField();
    // Skip lines that are completely blank.
    if (!(fields.length === 1 && fields[0] === "")) records.push({ line: recordLine, fields });
    fields = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        // After a closing quote only whitespace may precede the delimiter / line end.
        while (i < n && (text[i] === " " || text[i] === "\t")) i++;
        if (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
          return { records, error: `Unexpected character after closing quote on line ${line}` };
        }
        continue;
      }
      if (c === "\n") line++;
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (field.trim() === "") {
        field = "";
        inQuotes = true;
        quotedField = true;
        i++;
        continue;
      }
      return { records, error: `Unexpected quote inside an unquoted field on line ${line}` };
    }
    if (c === ",") {
      endField();
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      endRecord();
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++;
      line++;
      recordLine = line;
      continue;
    }
    field += c;
    i++;
  }
  if (inQuotes) return { records, error: `Unclosed quoted field starting on line ${recordLine}` };
  if (field !== "" || fields.length > 0) endRecord();
  return { records, error: null };
}

// ---------------------------------------------------------------------------------------------
// Character / content checks
// ---------------------------------------------------------------------------------------------

/** C0 controls (except TAB/LF/CR), DEL, C1 controls, bidi overrides, zero-width chars, BOM. */
export const UNSUPPORTED_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿�]/;
const TAB_OR_NEWLINE = /[\t\r\n]/;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** True when the content is evidently not a text CSV (binary, spreadsheet container, PDF…). */
export function looksBinary(text: string): string | null {
  if (text.includes("\u0000")) return "File contains NUL bytes; it is not a text CSV";
  const head = text.slice(0, 8);
  if (head.startsWith("PK\u0003\u0004")) return "File is a ZIP/XLSX archive, not a CSV. Export it as CSV first";
  if (head.startsWith("%PDF")) return "File is a PDF, not a CSV";
  if (head.startsWith("ÐÏ\u0011à") || head.startsWith("��\u0011")) return "File is a legacy Excel document, not a CSV";
  const sample = text.slice(0, 4096);
  if (sample.length > 0) {
    let bad = 0;
    for (const ch of sample) {
      const code = ch.codePointAt(0) ?? 0;
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 0xfffd) bad++;
    }
    if (bad / sample.length > 0.05) return "File contains binary data; it is not a text CSV";
  }
  return null;
}

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL.test(email);
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type WalletCheck = { ok: true; address: string } | { ok: false; message: string };

/** Validates a 0x address. All-lowercase / all-uppercase hex is accepted; mixed case must match EIP-55. */
export function checkWallet(raw: string): WalletCheck {
  const s = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, message: "Wallet must be 0x followed by 40 hex characters" };
  if (s.toLowerCase() === ZERO_ADDRESS) return { ok: false, message: "Wallet cannot be the zero address" };
  const body = s.slice(2);
  const checksummed = getAddress(s.toLowerCase());
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && checksummed !== s) return { ok: false, message: "Wallet checksum is wrong (EIP-55). Check for a typo" };
  return { ok: true, address: checksummed };
}

/** PayFlow's own contracts can never receive a payment: the escrow rejects the MUSD token in
 *  addPayments (InvalidRecipient), and money sent to the escrow or registry would be stuck. */
export function reservedRecipientMessage(address: string): string | null {
  const a = address.trim().toLowerCase();
  if (a === ZERO_ADDRESS) return null;
  const reserved: [string, string][] = [
    [contracts.musd, "Wallet is the MUSD token contract, not a person's wallet"],
    [contracts.escrow, "Wallet is the PayFlow escrow contract, not a person's wallet"],
    [contracts.registry, "Wallet is the PayFlow registry contract, not a person's wallet"],
  ];
  for (const [addr, message] of reserved) {
    const r = addr.toLowerCase();
    if (r !== ZERO_ADDRESS && r === a) return message;
  }
  return null;
}

/** checkWallet plus the payment-recipient rule: PayFlow's own contracts are refused. */
export function checkRecipientWallet(raw: string): WalletCheck {
  const w = checkWallet(raw);
  if (!w.ok) return w;
  const reserved = reservedRecipientMessage(w.address);
  return reserved ? { ok: false, message: reserved } : w;
}

function normalizeHeader(h: string): string {
  return h.replace(/^﻿/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

// ---------------------------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------------------------

export interface RecipientExtras {
  externalId: string | null;
  paymentCategory: PaymentCategory | null;
  paymentFrequency: PaymentFrequency | null;
}

export interface RecipientCsvResult {
  report: CsvValidationReport;
  /** Parallel to report.rows. */
  extras: RecipientExtras[];
}

type Kind = "payroll" | "recipients";

function issue(row: number | null, column: string | null, code: CsvIssueCode, message: string, severity: "error" | "warning" = "error"): CsvIssue {
  return { row, column, code, message, severity };
}

function emptyReport(fileIssues: CsvIssue[], balanceWei?: string): CsvValidationReport {
  const r: CsvValidationReport = {
    totalRows: 0, validRows: 0, invalidRows: 0, duplicateWallets: 0, invalidWallets: 0,
    payableRecipients: 0, totalPayableWei: "0", fileIssues, rows: [],
  };
  if (balanceWei !== undefined && /^\d+$/.test(balanceWei)) r.balanceCheck = { balanceWei, sufficient: true };
  return r;
}

function validate(kind: Kind, text: string, opts: CsvValidateOptions): RecipientCsvResult {
  const fileIssues: CsvIssue[] = [];
  const balanceWei = opts.employerBalanceWei;

  if (typeof text !== "string") return { report: emptyReport([issue(null, null, "not_csv", "CSV content must be text")]), extras: [] };
  if (byteLength(text) > CSV_MAX_BYTES) {
    return { report: emptyReport([issue(null, null, "file_too_large", `File is larger than ${CSV_MAX_BYTES / 1024 / 1024} MB`)], balanceWei), extras: [] };
  }
  const binary = looksBinary(text);
  if (binary) return { report: emptyReport([issue(null, null, "not_csv", binary)], balanceWei), extras: [] };

  const body = text.replace(/^﻿/, "");
  if (body.trim() === "") return { report: emptyReport([issue(null, null, "not_csv", "File is empty")], balanceWei), extras: [] };

  const parsed = parseCsv(body);
  if (parsed.error) return { report: emptyReport([issue(null, null, "not_csv", `Not a valid CSV: ${parsed.error}`)], balanceWei), extras: [] };
  const [headerRec, ...dataRecs] = parsed.records;
  if (!headerRec) return { report: emptyReport([issue(null, null, "not_csv", "File has no header row")], balanceWei), extras: [] };

  const known: readonly string[] = kind === "payroll" ? PAYROLL_COLUMNS : RECIPIENT_COLUMNS;
  const required: readonly string[] = kind === "payroll" ? PAYROLL_REQUIRED : RECIPIENT_REQUIRED;
  const header = headerRec.fields.map(normalizeHeader);
  const colIndex = new Map<string, number>();
  header.forEach((h, idx) => {
    if (h === "") {
      fileIssues.push(issue(0, null, "unknown_column", `Header column ${idx + 1} is empty and will be ignored`, "warning"));
      return;
    }
    if (colIndex.has(h)) {
      fileIssues.push(issue(0, h, "unknown_column", `Column "${h}" appears more than once; only the first is used`, "error"));
      return;
    }
    colIndex.set(h, idx);
    if (!known.includes(h)) fileIssues.push(issue(0, h, "unknown_column", `Unknown column "${h}" will be ignored`, "warning"));
  });
  const missing = required.filter((c) => !colIndex.has(c));
  for (const c of missing) fileIssues.push(issue(0, c, "missing_column", `Required column "${c}" is missing`));

  const maxRows = Math.min(Math.max(1, Math.floor(opts.maxRows ?? CSV_MAX_ROWS)), CSV_MAX_ROWS);
  if (dataRecs.length > maxRows) {
    fileIssues.push(issue(null, null, "too_many_rows", `File has ${dataRecs.length} rows; the limit is ${maxRows}`));
  }
  if (dataRecs.length === 0) fileIssues.push(issue(null, null, "empty_value", "File has a header but no data rows"));

  let maxAmountWei: bigint;
  try {
    maxAmountWei = parseMusd(opts.maxAmount ?? DEFAULT_MAX_AMOUNT);
  } catch {
    maxAmountWei = parseMusd(DEFAULT_MAX_AMOUNT);
  }
  if (maxAmountWei > UINT128_MAX) maxAmountWei = UINT128_MAX;

  const get = (fields: string[], col: string): string => {
    const idx = colIndex.get(col);
    return idx === undefined ? "" : fields[idx] ?? "";
  };

  const rows: CsvRow[] = [];
  const extras: RecipientExtras[] = [];
  const firstByWallet = new Map<string, number>();
  const firstByContent = new Map<string, number>();

  dataRecs.forEach((rec, i) => {
    const rowNo = i + 1;
    const issues: CsvIssue[] = [];
    const f = rec.fields;

    if (rowNo > maxRows) issues.push(issue(rowNo, null, "too_many_rows", `Row is beyond the ${maxRows}-row limit`));
    if (f.length > header.length) {
      const extra = f.slice(header.length).some((v) => v.trim() !== "");
      if (extra) issues.push(issue(rowNo, null, "unknown_column", `Row has ${f.length} values but the header has ${header.length} columns`));
    }

    // Character checks on every known cell.
    for (const col of known) {
      if (!colIndex.has(col)) continue;
      const v = get(f, col);
      if (UNSUPPORTED_CHARS.test(v) || (col !== "description" && TAB_OR_NEWLINE.test(v))) {
        issues.push(issue(rowNo, col, "unsupported_characters", `"${col}" contains control or invisible characters`));
      }
    }

    const name = get(f, "name").trim();
    if (colIndex.has("name") && name === "") issues.push(issue(rowNo, "name", "empty_value", "Name is required"));
    else if (name.length > 200) issues.push(issue(rowNo, "name", "unsupported_characters", "Name is longer than 200 characters"));

    const emailRaw = get(f, "email").trim();
    let email: string | null = null;
    if (emailRaw !== "") {
      if (isValidEmail(emailRaw)) email = emailRaw.toLowerCase();
      else issues.push(issue(rowNo, "email", "invalid_email", `"${emailRaw}" is not a valid email address`));
    }

    const walletRaw = get(f, "wallet_address").trim();
    let walletAddress = walletRaw;
    let walletValid = false;
    if (colIndex.has("wallet_address")) {
      if (walletRaw === "") {
        issues.push(issue(rowNo, "wallet_address", "empty_value", "Wallet address is required"));
      } else {
        const w = checkRecipientWallet(walletRaw);
        if (w.ok) {
          walletAddress = w.address;
          walletValid = true;
        } else {
          issues.push(issue(rowNo, "wallet_address", "invalid_wallet", w.message));
        }
      }
    }

    const amount = get(f, "amount").trim();
    let amountWei: bigint | null = null;
    const amountRequired = kind === "payroll";
    if (colIndex.has("amount") && (amount !== "" || amountRequired)) {
      if (amount === "") {
        issues.push(issue(rowNo, "amount", "empty_value", "Amount is required"));
      } else {
        try {
          const wei = parseMusd(amount);
          if (wei <= 0n) issues.push(issue(rowNo, "amount", "non_positive_amount", "Amount must be greater than zero"));
          else if (wei > maxAmountWei) issues.push(issue(rowNo, "amount", "amount_too_large", `Amount is above the per-row limit of ${opts.maxAmount ?? DEFAULT_MAX_AMOUNT} MUSD`));
          else amountWei = wei;
        } catch (e) {
          if (e instanceof MoneyParseError && e.reason === "negative") issues.push(issue(rowNo, "amount", "non_positive_amount", "Amount must be greater than zero"));
          else if (e instanceof MoneyParseError && e.reason === "too_many_decimals") issues.push(issue(rowNo, "amount", "too_many_decimals", "MUSD allows at most 18 decimal places"));
          else issues.push(issue(rowNo, "amount", "invalid_amount", `"${amount}" is not a valid amount`));
        }
      }
    }

    const description = get(f, "description").trim();
    if (description.length > 500) issues.push(issue(rowNo, "description", "unsupported_characters", "Description is longer than 500 characters"));
    const departmentRaw = get(f, "department").trim();
    const department = departmentRaw === "" ? null : departmentRaw;
    if (departmentRaw.length > 100) issues.push(issue(rowNo, "department", "unsupported_characters", "Department is longer than 100 characters"));

    const ex: RecipientExtras = { externalId: null, paymentCategory: null, paymentFrequency: null };
    if (kind === "recipients") {
      const ext = get(f, "external_id").trim();
      ex.externalId = ext === "" ? null : ext;
      if (ext.length > 100) issues.push(issue(rowNo, "external_id", "unsupported_characters", "external_id is longer than 100 characters"));
      const cat = get(f, "payment_category").trim().toLowerCase();
      if (cat !== "") {
        if ((PAYMENT_CATEGORIES as readonly string[]).includes(cat)) ex.paymentCategory = cat as PaymentCategory;
        else issues.push(issue(rowNo, "payment_category", "unsupported_characters", `payment_category must be one of ${PAYMENT_CATEGORIES.join(", ")}`));
      }
      const freq = get(f, "payment_frequency").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (freq !== "") {
        if ((PAYMENT_FREQUENCIES as readonly string[]).includes(freq)) ex.paymentFrequency = freq as PaymentFrequency;
        else issues.push(issue(rowNo, "payment_frequency", "unsupported_characters", `payment_frequency must be one of ${PAYMENT_FREQUENCIES.join(", ")}`));
      }
    }

    // Exact duplicate rows (all known values equal after normalization).
    const contentKey = known.map((c) => (c === "wallet_address" ? walletAddress.toLowerCase() : get(f, c).trim())).join("\u0001");
    const firstSame = firstByContent.get(contentKey);
    if (firstSame !== undefined) issues.push(issue(rowNo, null, "duplicate_row", `Row is an exact duplicate of row ${firstSame}`));
    else firstByContent.set(contentKey, rowNo);

    if (walletValid) {
      const key = walletAddress.toLowerCase();
      const first = firstByWallet.get(key);
      if (first !== undefined) issues.push(issue(rowNo, "wallet_address", "duplicate_wallet", `Wallet already appears on row ${first}`));
      else firstByWallet.set(key, rowNo);
    }

    const valid = !issues.some((x) => x.severity === "error");
    rows.push({ row: rowNo, name, email, walletAddress, amount, amountWei: amountWei === null ? null : amountWei.toString(), description, department, valid, issues });
    extras.push(ex);
  });

  // A file-level error (missing column, too many rows) invalidates every row for payment purposes.
  const fileBlocking = fileIssues.some((x) => x.severity === "error");
  let total = 0n;
  let validRows = 0;
  for (const r of rows) {
    if (fileBlocking) r.valid = false;
    if (r.valid) {
      validRows++;
      if (r.amountWei) total += BigInt(r.amountWei);
    }
  }

  const report: CsvValidationReport = {
    totalRows: rows.length,
    validRows,
    invalidRows: rows.length - validRows,
    duplicateWallets: rows.filter((r) => r.issues.some((x) => x.code === "duplicate_wallet")).length,
    invalidWallets: rows.filter((r) => r.issues.some((x) => x.column === "wallet_address" && (x.code === "invalid_wallet" || x.code === "empty_value"))).length,
    payableRecipients: kind === "payroll" ? validRows : rows.filter((r) => r.valid && r.amountWei !== null).length,
    totalPayableWei: total.toString(),
    fileIssues,
    rows,
  };

  if (balanceWei !== undefined) {
    if (/^\d+$/.test(balanceWei)) {
      const sufficient = BigInt(balanceWei) >= total;
      report.balanceCheck = { balanceWei, sufficient };
      if (!sufficient) {
        fileIssues.push(issue(null, null, "amount_too_large", "Total payable is more than the employer wallet's MUSD balance", "warning"));
      }
    }
  }
  return { report, extras };
}

export function validatePayrollCsv(text: string, opts: CsvValidateOptions = {}): CsvValidationReport {
  return validate("payroll", text, opts).report;
}

export function validateRecipientCsv(text: string, opts: CsvValidateOptions = {}): CsvValidationReport {
  return validate("recipients", text, opts).report;
}

/** Recipient import with the extra per-row fields the CsvRow DTO does not carry. */
export function parseRecipientCsv(text: string, opts: CsvValidateOptions = {}): RecipientCsvResult {
  return validate("recipients", text, opts);
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

const FORMULA_START = /^[=+\-@\t\r]/;

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Escape one cell: neutralize spreadsheet formulas (prefix '), then RFC 4180 quote when needed. */
export function csvCell(v: unknown): string {
  let s = cellToString(v);
  if (typeof v !== "number" && typeof v !== "bigint" && (FORMULA_START.test(s) || FORMULA_START.test(s.trimStart()))) {
    s = "'" + s;
  }
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Rows → CSV text (CRLF line endings, header first). Formula-injection safe. */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}
