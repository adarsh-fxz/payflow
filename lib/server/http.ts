import "./guard";
import { z } from "zod";
import type { ApiErrorCode } from "../api-types";
import { CHAIN_UNAVAILABLE_MESSAGE, isChainUnavailable } from "./chain-errors";

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  rate_limited: 429,
  chain_mismatch: 422,
  not_deployed: 503,
  chain_unavailable: 503,
  internal: 500,
};

export class ApiHttpError extends Error {
  readonly status: number;
  constructor(public readonly code: ApiErrorCode, message: string, public readonly details?: unknown, status?: number) {
    super(message);
    this.status = status ?? STATUS[code];
  }
}

export const fail = (code: ApiErrorCode, message: string, details?: unknown, status?: number) => new ApiHttpError(code, message, details, status);

/** The run's on-chain payments differ from the reviewed draft: 409 chain_mismatch (details = ChainMismatch[]). */
export const runBlocked = (details: unknown) =>
  new ApiHttpError(
    "chain_mismatch",
    "This run is blocked: the payments recorded on-chain differ from the reviewed draft. Cancel the run and create a new one",
    details,
    409,
  );

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, replacer), { ...init, headers });
}

export function csvResponse(text: string | ReadableStream<Uint8Array>, filename: string): Response {
  return new Response(text, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function errorResponse(code: ApiErrorCode, message: string, details?: unknown, status?: number): Response {
  return json({ error: details === undefined ? { code, message } : { code, message, details } }, { status: status ?? STATUS[code] });
}

export function formatZod(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

function isNextControlFlow(e: unknown): boolean {
  const d = (e as { digest?: unknown } | null)?.digest;
  return typeof d === "string" && (d.startsWith("NEXT_") || d === "DYNAMIC_SERVER_USAGE");
}

/** Wraps a route handler: maps ApiHttpError / ZodError to the ApiError shape; hides internals. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    if (e instanceof ApiHttpError) return errorResponse(e.code, e.message, e.details, e.status);
    if (e instanceof z.ZodError) return errorResponse("invalid_input", formatZod(e), e.issues);
    if (isChainUnavailable(e)) {
      console.error(JSON.stringify({ level: "warn", msg: "chain unavailable", error: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
      return errorResponse("chain_unavailable", CHAIN_UNAVAILABLE_MESSAGE);
    }
    console.error(JSON.stringify({ level: "error", msg: "api unhandled", error: e instanceof Error ? e.stack ?? e.message : String(e) }));
    return errorResponse("internal", "Internal error");
  }
}

const MAX_BODY = 2 * 1024 * 1024;

/** Parses and validates a JSON body; 400 invalid_input on failure. */
export async function readJson<T extends z.ZodType>(req: Request, schema: T, maxBytes = MAX_BODY): Promise<z.infer<T>> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw fail("invalid_input", "Request body is too large");
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw fail("invalid_input", "Could not read request body");
  }
  if (text.length > maxBytes) throw fail("invalid_input", "Request body is too large");
  let raw: unknown;
  try {
    raw = text === "" ? {} : JSON.parse(text);
  } catch {
    throw fail("invalid_input", "Body must be valid JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiHttpError("invalid_input", formatZod(r.error), r.error.issues);
  return r.data;
}

export function readQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const u = new URL(req.url);
  const obj: Record<string, string> = {};
  for (const [k, v] of u.searchParams) if (v !== "") obj[k] = v;
  const r = schema.safeParse(obj);
  if (!r.success) throw new ApiHttpError("invalid_input", formatZod(r.error), r.error.issues);
  return r.data;
}

export const zUuid = z.string().uuid();

export function parseUuid(v: string, what = "id"): string {
  if (!zUuid.safeParse(v).success) throw fail("not_found", `${what} not found`);
  return v.toLowerCase();
}

/**
 * Client IP for rate limiting. Only headers the hosting platform sets are trusted:
 *  - on Vercel (VERCEL=1): x-vercel-forwarded-for, else x-real-ip (both set by the edge);
 *  - elsewhere (Render, local): the LAST x-forwarded-for hop (appended by our own proxy), else x-real-ip.
 * The first x-forwarded-for entry is client-controlled and never used.
 */
export function clientIp(req: Request): string {
  const h = req.headers;
  const clean = (v: string | null | undefined) => (v ?? "").trim().slice(0, 64);
  if (process.env.VERCEL) {
    const v = clean(h.get("x-vercel-forwarded-for")?.split(",")[0]) || clean(h.get("x-real-ip"));
    if (v) return v;
  }
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((x) => x.trim()).filter(Boolean);
    const last = clean(hops[hops.length - 1]);
    if (last) return last;
  }
  return clean(h.get("x-real-ip")) || "unknown";
}

export type RouteCtx<P extends Record<string, string>> = { params: Promise<P> };
