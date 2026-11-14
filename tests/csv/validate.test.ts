import { describe, expect, it } from "vitest";
import {
  CSV_MAX_BYTES,
  PAYROLL_CSV_TEMPLATE,
  checkWallet,
  parseCsv,
  parseRecipientCsv,
  toCsv,
  validatePayrollCsv,
} from "@/lib/csv/validate";

const W1 = "0x52908400098527886E0F7030069857D2E4169EE7"; // EIP-55 test vector
const W2 = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";
const W3 = "0xde709f2102306220921060314715629080e2fb77";
const W3_CHECKSUM = "0xde709f2102306220921060314715629080e2fb77".toLowerCase();

const csv = (...lines: string[]) => lines.join("\n");
const HEADER = "name,email,wallet_address,amount,description,department";

describe("parseCsv", () => {
  it("handles quoted fields with commas, escaped quotes and newlines", () => {
    const r = parseCsv('a,b,c\r\n"Doe, Jane","say ""hi""","line1\nline2"\r\nx,y,z');
    expect(r.error).toBeNull();
    expect(r.records.map((x) => x.fields)).toEqual([
      ["a", "b", "c"],
      ["Doe, Jane", 'say "hi"', "line1\nline2"],
      ["x", "y", "z"],
    ]);
  });

  it("skips blank lines and trims unquoted fields only", () => {
    const r = parseCsv('a,b\n\n  x , " y "\n');
    expect(r.records.map((x) => x.fields)).toEqual([["a", "b"], ["x", " y "]]);
  });

  it("rejects an unclosed quote and stray quotes", () => {
    expect(parseCsv('a,b\n"x,y').error).toMatch(/Unclosed/);
    expect(parseCsv('a,b\nx"y,z').error).toMatch(/Unexpected quote/);
    expect(parseCsv('a,b\n"x"y,z').error).toMatch(/after closing quote/);
  });
});

describe("checkWallet", () => {
  it("accepts checksum and all-lowercase, normalizing to EIP-55", () => {
    expect(checkWallet(W1)).toEqual({ ok: true, address: W1 });
    const lower = checkWallet(W1.toLowerCase());
    expect(lower.ok && lower.address).toBe(W1);
  });
  it("rejects bad checksum, zero address and malformed input", () => {
    expect(checkWallet("0x52908400098527886E0F7030069857D2E4169Ee7").ok).toBe(false);
    expect(checkWallet("0x0000000000000000000000000000000000000000").ok).toBe(false);
    expect(checkWallet("0x1234").ok).toBe(false);
    expect(checkWallet("52908400098527886E0F7030069857D2E4169EE7").ok).toBe(false);
    expect(checkWallet("0xZZ908400098527886E0F7030069857D2E4169EE7").ok).toBe(false);
  });
});

describe("validatePayrollCsv", () => {
  it("validates a good file and totals exactly in wei", () => {
    const r = validatePayrollCsv(csv(HEADER, `Alice,alice@example.com,${W1},1500.50,Oct salary,Eng`, `Bob,,${W2},0.000000000000000001,,`));
    expect(r.fileIssues).toEqual([]);
    expect(r.totalRows).toBe(2);
    expect(r.validRows).toBe(2);
    expect(r.payableRecipients).toBe(2);
    expect(r.totalPayableWei).toBe("1500500000000000000001");
    expect(r.rows[0]).toMatchObject({ row: 1, name: "Alice", email: "alice@example.com", walletAddress: W1, amountWei: "1500500000000000000000", department: "Eng", valid: true });
    expect(r.rows[1]).toMatchObject({ department: null, email: null, description: "" });
  });

  it("requires the header columns and warns on unknown ones", () => {
    const r = validatePayrollCsv(csv("name,wallet,amount,notes", `A,${W1},1,x`));
    const codes = r.fileIssues.map((i) => [i.code, i.column, i.severity]);
    expect(codes).toContainEqual(["missing_column", "wallet_address", "error"]);
    expect(codes).toContainEqual(["unknown_column", "notes", "warning"]);
    expect(r.validRows).toBe(0);
    expect(r.rows).toHaveLength(1); // still reported
  });

  it("accepts optional columns being absent and normalizes header case/spaces", () => {
    const r = validatePayrollCsv(csv("Name,Wallet Address,AMOUNT", `A,${W1},10`));
    expect(r.fileIssues).toEqual([]);
    expect(r.validRows).toBe(1);
  });

  it("flags duplicate wallets after the first occurrence and exact duplicate rows", () => {
    const r = validatePayrollCsv(
      csv(HEADER, `A,,${W1},1,,`, `B,,${W1.toLowerCase()},2,,`, `A,,${W1},1,,`, `C,,${W2},3,,`),
    );
    expect(r.rows.map((x) => x.valid)).toEqual([true, false, false, true]);
    expect(r.duplicateWallets).toBe(2);
    const row2 = r.rows[1]!.issues.find((i) => i.code === "duplicate_wallet")!;
    expect(row2.message).toMatch(/row 1/);
    expect(r.rows[2]!.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["duplicate_row", "duplicate_wallet"]));
    expect(r.totalPayableWei).toBe((4n * 10n ** 18n).toString());
  });

  it("validates wallets per row", () => {
    const r = validatePayrollCsv(csv(HEADER, `A,,0x52908400098527886E0F7030069857D2E4169Ee7,1,,`, `B,,0x0000000000000000000000000000000000000000,1,,`, `C,,,1,,`, `D,,${W3},1,,`));
    expect(r.invalidWallets).toBe(3);
    expect(r.rows[0]!.issues[0]!.code).toBe("invalid_wallet");
    expect(r.rows[2]!.issues[0]!.code).toBe("empty_value");
    expect(r.rows[3]!.valid).toBe(true);
    expect(r.rows[3]!.walletAddress.toLowerCase()).toBe(W3_CHECKSUM);
    expect(r.rows[0]!.walletAddress).toBe("0x52908400098527886E0F7030069857D2E4169Ee7"); // raw when invalid
  });

  it("validates amounts: decimals, sign, zero, garbage, max per row", () => {
    const r = validatePayrollCsv(
      csv(HEADER, `A,,${W1},1.123456789012345678,,`, `B,,${W2},1.1234567890123456789,,`, `C,,${W3},-5,,`, `D,,0x1111111111111111111111111111111111111111,0,,`, `E,,0x2222222222222222222222222222222222222222,abc,,`, `F,,0x3333333333333333333333333333333333333333,1000001,,`, `G,,0x4444444444444444444444444444444444444444,"1,000",,`),
      { maxAmount: "1000000" },
    );
    const codes = r.rows.map((x) => x.issues.map((i) => i.code)[0] ?? "ok");
    expect(codes).toEqual(["ok", "too_many_decimals", "non_positive_amount", "non_positive_amount", "invalid_amount", "amount_too_large", "ok"]);
    expect(r.rows[6]!.amountWei).toBe((1000n * 10n ** 18n).toString());
  });

  it("validates emails and rejects control / invisible characters", () => {
    const r = validatePayrollCsv(csv(HEADER, `A,not-an-email,${W1},1,,`, `B‮,,${W2},1,,`, `C,,${W3},1,"multi\nline ok",`));
    expect(r.rows[0]!.issues[0]!.code).toBe("invalid_email");
    expect(r.rows[1]!.issues[0]!.code).toBe("unsupported_characters");
    expect(r.rows[2]!.valid).toBe(true);
  });

  it("enforces max rows but still reports every row", () => {
    const lines = [HEADER];
    for (let i = 0; i < 6; i++) lines.push(`R${i},,0x${(i + 1).toString(16).padStart(40, "0")},1,,`);
    const r = validatePayrollCsv(lines.join("\n"), { maxRows: 5 });
    expect(r.fileIssues.some((i) => i.code === "too_many_rows")).toBe(true);
    expect(r.totalRows).toBe(6);
    expect(r.rows[5]!.issues.some((i) => i.code === "too_many_rows")).toBe(true);
    expect(r.validRows).toBe(0);
  });

  it("rejects oversize, binary and spreadsheet content regardless of extension", () => {
    expect(validatePayrollCsv("a".repeat(CSV_MAX_BYTES + 1)).fileIssues[0]!.code).toBe("file_too_large");
    expect(validatePayrollCsv(`${HEADER}\nA\u0000B,,${W1},1,,`).fileIssues[0]!.code).toBe("not_csv");
    expect(validatePayrollCsv("PK\u0003\u0004\u0014\u0000\u0006\u0000").fileIssues[0]!.code).toBe("not_csv");
    expect(validatePayrollCsv("%PDF-1.7 ...").fileIssues[0]!.code).toBe("not_csv");
    expect(validatePayrollCsv("").fileIssues[0]!.code).toBe("not_csv");
    expect(validatePayrollCsv('name,wallet_address,amount\n"oops').fileIssues[0]!.code).toBe("not_csv");
  });

  it("checks the employer balance", () => {
    const ok = validatePayrollCsv(csv(HEADER, `A,,${W1},10,,`), { employerBalanceWei: (10n * 10n ** 18n).toString() });
    expect(ok.balanceCheck).toEqual({ balanceWei: "10000000000000000000", sufficient: true });
    const low = validatePayrollCsv(csv(HEADER, `A,,${W1},10,,`), { employerBalanceWei: "1" });
    expect(low.balanceCheck?.sufficient).toBe(false);
    expect(low.fileIssues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("strips a UTF-8 BOM and handles CRLF", () => {
    const r = validatePayrollCsv(`﻿${HEADER}\r\nA,,${W1},1,,\r\n`);
    expect(r.fileIssues).toEqual([]);
    expect(r.validRows).toBe(1);
  });

  it("template has the right header but cannot pay an unedited placeholder", () => {
    const r = validatePayrollCsv(PAYROLL_CSV_TEMPLATE);
    expect(r.fileIssues).toEqual([]);
    expect(r.rows[0]!.issues[0]!.code).toBe("invalid_wallet");
  });
});

describe("parseRecipientCsv", () => {
  it("makes amount optional and parses the extra columns", () => {
    const { report, extras } = parseRecipientCsv(
      csv("name,wallet_address,external_id,payment_category,payment_frequency", `A,${W1},E-1,salary,Monthly`, `B,${W2},,bogus,`),
    );
    expect(report.rows[0]!.valid).toBe(true);
    expect(extras[0]).toEqual({ externalId: "E-1", paymentCategory: "salary", paymentFrequency: "monthly" });
    expect(report.rows[1]!.valid).toBe(false);
  });
});

describe("toCsv", () => {
  it("neutralizes formula injection and quotes correctly", () => {
    const out = toCsv(
      [{ a: "=HYPERLINK(\"x\")", b: "+1", c: "-2", d: "@SUM(A1)", e: "\tcmd", f: "  =1+1", g: 'he said "hi", ok', h: 5, i: 7n, j: null }],
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
    );
    const [header, row] = out.trimEnd().split("\r\n");
    expect(header).toBe("a,b,c,d,e,f,g,h,i,j");
    expect(row).toBe(`"'=HYPERLINK(""x"")",'+1,'-2,'@SUM(A1),'\tcmd,'  =1+1,"he said ""hi"", ok",5,7,`);
  });

  it("round-trips through the parser", () => {
    const rows = [{ name: "Doe, Jane", note: 'x "y"\nz' }];
    const parsed = parseCsv(toCsv(rows, ["name", "note"]));
    expect(parsed.records[1]!.fields).toEqual(["Doe, Jane", 'x "y"\nz']);
  });
});

describe("PayFlow's own contracts are not recipients", () => {
  const MUSD = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";

  it("rejects the MUSD token address in any case, as invalid_wallet with a clear message", async () => {
    const { checkRecipientWallet } = await import("@/lib/csv/validate");
    for (const w of [MUSD, MUSD.toLowerCase()]) {
      const r = checkRecipientWallet(w);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/MUSD token contract/);
    }
    expect(checkRecipientWallet(W1).ok).toBe(true);
    // A plain wallet check (members, treasury) is unaffected.
    expect(checkWallet(MUSD).ok).toBe(true);
  });

  it("payroll CSV: the token row is invalid and counted as an invalid wallet; others still pass", () => {
    const r = validatePayrollCsv(csv(HEADER, `Token,,${MUSD.toLowerCase()},10,,`, `Jane,,${W1},10,,`));
    expect(r.rows[0]!.valid).toBe(false);
    expect(r.rows[0]!.issues).toEqual([expect.objectContaining({ column: "wallet_address", code: "invalid_wallet", message: expect.stringMatching(/MUSD token/) })]);
    expect(r.rows[1]!.valid).toBe(true);
    expect(r.invalidWallets).toBe(1);
    expect(r.totalPayableWei).toBe((10n * 10n ** 18n).toString());
  });

  it("recipient CSV import refuses it too", () => {
    const r = parseRecipientCsv(`name,wallet_address\nToken,${MUSD}\n`);
    expect(r.report.rows[0]!.valid).toBe(false);
  });
});
