import { describe, expect, it, vi, beforeEach } from "vitest";
import { HttpRequestError } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

// Mezo Passport Bitcoin wallets sign as a smart account; sign-in falls back to an on-chain check.
const onchainVerify = vi.fn();
vi.mock("@/lib/server/chain", async (orig) => {
  const real = await orig<typeof import("@/lib/server/chain")>();
  return { ...real, publicClient: () => ({ verifyMessage: onchainVerify }) };
});

const { verifyWalletSignature } = await import("@/lib/server/session");
const { ApiHttpError } = await import("@/lib/server/http");

const eoa = privateKeyToAccount(generatePrivateKey());
const smartAccount = "0x00000000000000000000000000000000000a11ce" as const;
const message = "payflow sign-in test";

describe("verifyWalletSignature", () => {
  beforeEach(() => onchainVerify.mockReset());

  it("accepts a plain wallet signature without calling the RPC", async () => {
    const signature = await eoa.signMessage({ message });
    await expect(verifyWalletSignature({ address: eoa.address, message, signature })).resolves.toBe(true);
    expect(onchainVerify).not.toHaveBeenCalled();
  });

  it("accepts a smart-account signature the chain validates (ERC-1271 / ERC-6492)", async () => {
    onchainVerify.mockResolvedValueOnce(true);
    const signature = "0x" + "ab".repeat(200);
    await expect(verifyWalletSignature({ address: smartAccount, message, signature: signature as `0x${string}` })).resolves.toBe(true);
    expect(onchainVerify).toHaveBeenCalledWith({ address: smartAccount, message, signature });
  });

  it("rejects a signature neither recovery nor the chain accepts", async () => {
    onchainVerify.mockResolvedValueOnce(false);
    const signature = await eoa.signMessage({ message });
    await expect(verifyWalletSignature({ address: smartAccount, message, signature })).resolves.toBe(false);
  });

  it("reports an RPC outage as chain_unavailable instead of a bad signature", async () => {
    onchainVerify.mockRejectedValueOnce(new HttpRequestError({ url: "https://rpc.test.mezo.org", details: "fetch failed" }));
    const err = await verifyWalletSignature({ address: smartAccount, message, signature: "0x1234" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiHttpError);
    expect((err as InstanceType<typeof ApiHttpError>).code).toBe("chain_unavailable");
  });
});
