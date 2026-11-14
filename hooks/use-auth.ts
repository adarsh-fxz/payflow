"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import type { Hex, NonceResponse, SessionResponse } from "@/lib/api-types";
import { api } from "@/lib/client/api";
import { useWallet } from "./use-wallet";
import { qk, useSession } from "./use-api";

/**
 * Wallet sign-in: POST /api/auth/nonce → personal_sign → POST /api/auth/verify.
 * `signedIn` is true only when the session wallet is the connected wallet.
 */
export function useAuth() {
  const w = useWallet();
  const session = useSession();
  const qc = useQueryClient();
  const { signMessageAsync } = useSignMessage();

  const sessionAddress = session.data?.address ?? null;
  const signedIn = Boolean(w.address && sessionAddress && sessionAddress.toLowerCase() === w.address.toLowerCase());

  const signIn = useMutation({
    mutationFn: async () => {
      if (!w.address) throw new Error("Connect a wallet first.");
      const address = w.address.toLowerCase() as Hex;
      const { message } = await api<NonceResponse>("/api/auth/nonce", { method: "POST", json: { address } });
      const signature = await signMessageAsync({ message });
      return api<SessionResponse>("/api/auth/verify", { method: "POST", json: { address, message, signature } });
    },
    onSuccess: async (res) => {
      qc.setQueryData(qk.session, { address: res.address ?? (w.address?.toLowerCase() as Hex) });
      await qc.invalidateQueries({ queryKey: ["api"], predicate: (q) => q.queryKey[1] !== "session" });
    },
  });

  const signOut = useMutation({
    mutationFn: () => api<unknown>("/api/auth/logout", { method: "POST", json: {} }),
    onSettled: async () => {
      qc.setQueryData(qk.session, { address: null });
      qc.removeQueries({ queryKey: ["api"], predicate: (q) => q.queryKey[1] !== "session" && q.queryKey[1] !== "health" && q.queryKey[1] !== "claim" });
    },
  });

  return {
    wallet: w,
    sessionAddress,
    sessionLoading: session.isLoading,
    signedIn,
    /** Session exists but for another wallet than the one connected. */
    mismatch: Boolean(w.address && sessionAddress && !signedIn),
    signIn,
    signOut,
  };
}
