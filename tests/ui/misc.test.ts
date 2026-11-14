import { describe, expect, it } from "vitest";
import { parsePaymentRef } from "@/lib/client/claim-link";
import { networkState } from "@/lib/client/guard";
import { canAdmin, canApprove, canOperate, roleNames } from "@/lib/client/roles";

describe("claim link parsing", () => {
  it("accepts links, paths and ids", () => {
    expect(parsePaymentRef("https://payflow.app/claim/4294967296")).toBe("4294967296");
    expect(parsePaymentRef("/claim/12?x=1")).toBe("12");
    expect(parsePaymentRef(" 0042 ")).toBe("42");
  });
  it("rejects junk", () => {
    expect(parsePaymentRef("")).toBeNull();
    expect(parsePaymentRef("0")).toBeNull();
    expect(parsePaymentRef("https://x.com/claim/abc")).toBeNull();
  });
});

describe("network state", () => {
  it("classifies wallet state", () => {
    expect(networkState(false, undefined).kind).toBe("disconnected");
    expect(networkState(true, 1).kind).toBe("wrong-network");
    expect(networkState(true, 31611).kind).toBe("ready");
  });
});

describe("roles", () => {
  it("reads the bitmask", () => {
    expect(roleNames(7)).toEqual(["Admin", "Approver", "Operator"]);
    expect(canOperate(1)).toBe(true);
    expect(canOperate(2)).toBe(false);
    expect(canApprove(2)).toBe(true);
    expect(canAdmin(4)).toBe(false);
  });
});
