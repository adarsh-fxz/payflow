// MUSD amount helpers. Isomorphic (browser + server): no node-only imports.
// All on-chain and API amounts are wei (bigint / decimal strings). Humans type "1,500.50".

export const MUSD_DECIMALS = 18;
export const MUSD_UNIT = 10n ** 18n;
/** PayrollEscrow stores amounts as uint128. */
export const UINT128_MAX = (1n << 128n) - 1n;

export type MoneyParseErrorReason = "empty" | "invalid" | "negative" | "too_many_decimals";

export class MoneyParseError extends Error {
  constructor(public readonly reason: MoneyParseErrorReason, message: string) {
    super(message);
    this.name = "MoneyParseError";
  }
}

const PLAIN = /^\d+(?:\.\d*)?$|^\.\d+$/;
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/**
 * Parse a human MUSD amount ("1500", "1,500.5", "0.000000000000000001") into wei.
 * Accepts optional thousands separators in correct 3-digit groups. Throws MoneyParseError on
 * empty / malformed / negative input or more than 18 decimal places. Zero is returned as 0n
 * (callers decide whether zero is allowed).
 */
export function parseMusd(human: string): bigint {
  if (typeof human !== "string") throw new MoneyParseError("invalid", "Amount must be text");
  const s = human.trim();
  if (s === "") throw new MoneyParseError("empty", "Amount is empty");
  if (s.startsWith("-")) throw new MoneyParseError("negative", "Amount cannot be negative");
  const body = s.startsWith("+") ? s.slice(1) : s;
  if (!PLAIN.test(body) && !GROUPED.test(body)) throw new MoneyParseError("invalid", `"${human}" is not a valid amount`);
  const clean = body.replace(/,/g, "");
  const [intPart, fracPart = ""] = clean.split(".");
  if (fracPart.length > MUSD_DECIMALS) {
    throw new MoneyParseError("too_many_decimals", `Amount has ${fracPart.length} decimal places; MUSD allows at most 18`);
  }
  const whole = BigInt(intPart === "" ? "0" : intPart);
  const frac = fracPart === "" ? 0n : BigInt(fracPart.padEnd(MUSD_DECIMALS, "0"));
  return whole * MUSD_UNIT + frac;
}

/** Like parseMusd but returns null instead of throwing. */
export function tryParseMusd(human: string): bigint | null {
  try {
    return parseMusd(human);
  } catch {
    return null;
  }
}

function toBigInt(wei: bigint | string): bigint {
  if (typeof wei === "bigint") return wei;
  const s = String(wei).trim();
  if (!/^-?\d+$/.test(s)) throw new MoneyParseError("invalid", `"${wei}" is not a wei integer`);
  return BigInt(s);
}

function group(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Round |wei| to `decimals` places (half-up) and return [integer, fraction] digit strings. */
function roundParts(abs: bigint, decimals: number): [string, string] {
  const d = Math.max(0, Math.min(MUSD_DECIMALS, Math.floor(decimals)));
  const scale = 10n ** BigInt(MUSD_DECIMALS - d);
  let units = abs / scale;
  if ((abs % scale) * 2n >= scale && scale > 1n) units += 1n;
  const base = 10n ** BigInt(d);
  const intPart = (units / base).toString();
  const frac = d === 0 ? "" : (units % base).toString().padStart(d, "0");
  return [intPart, frac];
}

/**
 * Format wei as MUSD: formatMusd(1500500000000000000000n) → "1,500.50".
 * opts.decimals (default 2) fixed fraction digits, half-up rounding.
 * opts.compact → "1.5K", "2.25M", "3.1B" (uses at most `decimals` fraction digits, trims zeros).
 * Never shows a non-zero amount as "0.00": tiny values render as "<0.01".
 */
export function formatMusd(wei: bigint | string, opts: { decimals?: number; compact?: boolean } = {}): string {
  const v = toBigInt(wei);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const decimals = opts.decimals ?? 2;
  const sign = neg ? "-" : "";

  if (opts.compact) {
    const units: [bigint, string][] = [
      [10n ** 12n * MUSD_UNIT, "T"],
      [10n ** 9n * MUSD_UNIT, "B"],
      [10n ** 6n * MUSD_UNIT, "M"],
      [10n ** 3n * MUSD_UNIT, "K"],
    ];
    for (const [size, suffix] of units) {
      if (abs >= size) {
        // Scale to an 18-decimal fixed-point number of `suffix` units, then format it.
        const scaled = (abs * MUSD_UNIT) / size;
        const [i, f] = roundParts(scaled, Math.min(decimals, 2));
        const trimmed = f.replace(/0+$/, "");
        return `${sign}${group(i)}${trimmed ? "." + trimmed : ""}${suffix}`;
      }
    }
  }

  const [i, f] = roundParts(abs, decimals);
  if (abs > 0n && /^0+$/.test(i + f)) {
    const d = Math.max(0, Math.min(MUSD_DECIMALS, Math.floor(decimals)));
    return `${sign}<${d === 0 ? "1" : "0." + "0".repeat(d - 1) + "1"}`;
  }
  return `${sign}${group(i)}${f ? "." + f : ""}`;
}

/** Exact decimal string with no grouping and trailing zeros trimmed: 1500500000000000000000n → "1500.5". */
export function weiToDecimalString(wei: bigint | string): string {
  const v = toBigInt(wei);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const i = (abs / MUSD_UNIT).toString();
  const f = (abs % MUSD_UNIT).toString().padStart(MUSD_DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${i}${f ? "." + f : ""}`;
}
