import { describe, expect, it } from "vitest";
import { MoneyParseError, MUSD_UNIT, formatMusd, parseMusd, tryParseMusd, weiToDecimalString } from "@/lib/money";

describe("parseMusd", () => {
  it("parses integers, decimals and grouped thousands exactly", () => {
    expect(parseMusd("1")).toBe(MUSD_UNIT);
    expect(parseMusd("1500.5")).toBe(1500n * MUSD_UNIT + MUSD_UNIT / 2n);
    expect(parseMusd("1,234,567.89")).toBe(123456789n * 10n ** 16n);
    expect(parseMusd(".5")).toBe(MUSD_UNIT / 2n);
    expect(parseMusd("0.000000000000000001")).toBe(1n);
    expect(parseMusd(" 2 ")).toBe(2n * MUSD_UNIT);
    expect(parseMusd("0")).toBe(0n);
  });

  it("throws typed errors", () => {
    const reason = (s: string) => {
      try {
        parseMusd(s);
        return "ok";
      } catch (e) {
        return e instanceof MoneyParseError ? e.reason : "other";
      }
    };
    expect(reason("1.0000000000000000001")).toBe("too_many_decimals");
    expect(reason("-1")).toBe("negative");
    expect(reason("")).toBe("empty");
    expect(reason("1e18")).toBe("invalid");
    expect(reason("12,34")).toBe("invalid");
    expect(reason("1.2.3")).toBe("invalid");
    expect(reason("abc")).toBe("invalid");
    expect(tryParseMusd("x")).toBeNull();
  });
});

describe("formatMusd", () => {
  it("formats with grouping and fixed decimals (half-up)", () => {
    expect(formatMusd(parseMusd("1500.5"))).toBe("1,500.50");
    expect(formatMusd("1234567890000000000000000")).toBe("1,234,567.89");
    expect(formatMusd(parseMusd("1.005"))).toBe("1.01");
    expect(formatMusd(parseMusd("1.004"))).toBe("1.00");
    expect(formatMusd(parseMusd("3"), { decimals: 0 })).toBe("3");
    expect(formatMusd(0n)).toBe("0.00");
    expect(formatMusd(-parseMusd("2.5"))).toBe("-2.50");
  });
  it("never renders a tiny non-zero amount as zero", () => {
    expect(formatMusd(1n)).toBe("<0.01");
    expect(formatMusd(1n, { decimals: 4 })).toBe("<0.0001");
  });
  it("compacts large values", () => {
    expect(formatMusd(parseMusd("1500"), { compact: true })).toBe("1.5K");
    expect(formatMusd(parseMusd("2250000"), { compact: true })).toBe("2.25M");
    expect(formatMusd(parseMusd("3100000000"), { compact: true })).toBe("3.1B");
    expect(formatMusd(parseMusd("999"), { compact: true })).toBe("999.00");
  });
  it("exact decimal string", () => {
    expect(weiToDecimalString(parseMusd("1500.5"))).toBe("1500.5");
    expect(weiToDecimalString(1n)).toBe("0.000000000000000001");
    expect(weiToDecimalString("0")).toBe("0");
  });
});
