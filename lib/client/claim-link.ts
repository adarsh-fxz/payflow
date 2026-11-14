/** Accepts a claim link ("https://…/claim/123"), a path ("/claim/123") or a bare payment id. */
export function parsePaymentRef(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const fromPath = /\/claim\/(\d{1,78})(?:[/?#]|$)/.exec(s);
  if (fromPath) return normalize(fromPath[1]);
  if (/^\d{1,78}$/.test(s)) return normalize(s);
  return null;
}

function normalize(digits: string): string | null {
  try {
    const n = BigInt(digits);
    if (n <= 0n || n >= 1n << 256n) return null;
    return n.toString();
  } catch {
    return null;
  }
}

export function claimPath(paymentId: string) {
  return `/claim/${paymentId}`;
}
