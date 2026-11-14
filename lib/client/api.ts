import type { ApiError, ApiErrorCode } from "@/lib/api-types";

/** Error thrown for any non-2xx API response; carries the contract's error code. */
export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      Accept: "application/json",
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const type = res.headers.get("content-type") ?? "";
  const body: unknown = type.includes("application/json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const e = (body as ApiError | null)?.error;
    throw new ApiClientError(
      res.status,
      e?.code ?? (res.status === 401 ? "unauthenticated" : res.status === 404 ? "not_found" : "internal"),
      e?.message ?? (typeof body === "string" && body.length < 200 && body ? body : `Request failed (${res.status})`),
      e?.details,
    );
  }
  return body as T;
}

/** Fetch a text/csv endpoint and save it as a file. */
export async function downloadFromApi(path: string, filename: string): Promise<void> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const j = (await res.json()) as ApiError;
      message = j.error?.message ?? message;
    } catch {
      /* not json */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  saveBlob(blob, filename);
}

export function saveText(text: string, filename: string, type = "text/csv;charset=utf-8") {
  saveBlob(new Blob([text], { type }), filename);
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/** The API answered 503 chain_unavailable: Mezo's RPC is unreachable, saved data may still be shown. */
export function isChainUnavailable(err: unknown): boolean {
  return err instanceof ApiClientError && (err.code === "chain_unavailable" || err.status === 503);
}

/** Slow poll while Mezo is unreachable, after the normal retries have given up. */
export const OUTAGE_POLL_MS = 25_000;

/**
 * refetchInterval for queries whose banner says "Can't reach Mezo": keep checking slowly while the
 * last attempt failed with chain_unavailable, so the banner clears on its own once calls succeed.
 */
export function outagePoll(error: unknown, otherwise: number | false = false): number | false {
  return isChainUnavailable(error) ? OUTAGE_POLL_MS : otherwise;
}

/** Errors that will not fix themselves by retrying. */
export function isPermanentApiError(err: unknown): boolean {
  return err instanceof ApiClientError && ["unauthenticated", "forbidden", "not_found", "invalid_input", "not_deployed", "conflict"].includes(err.code);
}

/** Retry policy shared by every query: a few attempts with exponential backoff, never a tight loop. */
export const RETRY_LIMIT = 3;
export function shouldRetry(failureCount: number, err: unknown): boolean {
  if (isPermanentApiError(err)) return false;
  return failureCount < RETRY_LIMIT;
}
export function retryDelay(attempt: number): number {
  // 1s, 2s, 4s (capped at 15s)
  return Math.min(1000 * 2 ** attempt, 15_000);
}

/**
 * POST that retries 409 "not mined yet" answers (e.g. claim confirm right after a receipt) with
 * backoff: 1s, 2s, 4s, 8s. Other errors are thrown immediately.
 */
export async function postUntilMined<T>(path: string, json: unknown, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await api<T>(path, { method: "POST", json });
    } catch (e) {
      const notMined = e instanceof ApiClientError && e.status === 409 && /mined|not found|pending|receipt/i.test(e.message);
      if (!notMined || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, retryDelay(i)));
    }
  }
}
