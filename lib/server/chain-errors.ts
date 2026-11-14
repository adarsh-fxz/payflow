/**
 * Classifies errors from the Mezo RPC so an outage becomes a clear 503 `chain_unavailable`
 * (never a bare 500, never a long hang) while contract reverts keep their own handling.
 */
import "./guard";
import { BaseError, ContractFunctionRevertedError, HttpRequestError, RpcRequestError, SocketClosedError, TimeoutError, WebSocketRequestError } from "viem";

export const CHAIN_UNAVAILABLE_MESSAGE = "The Mezo network is not reachable right now. Your data is safe; try again in a minute.";

const NETWORK_TEXT = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|timed? ?out|aborted/i;

/** True when the error means "RPC unreachable / timed out / unhealthy", not "the contract said no". */
export function isChainUnavailable(e: unknown): boolean {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof ContractFunctionRevertedError)) return false;
    const hit = e.walk(
      (x) =>
        x instanceof HttpRequestError ||
        x instanceof TimeoutError ||
        x instanceof WebSocketRequestError ||
        x instanceof SocketClosedError ||
        (x instanceof RpcRequestError && !/revert/i.test(x.message)),
    );
    if (hit) return true;
    return NETWORK_TEXT.test(e.details ?? "") && !/revert/i.test(e.message);
  }
  if (e instanceof Error) {
    if (e.name === "AbortError" || e.name === "TimeoutError") return true;
    const cause = (e as { cause?: unknown }).cause;
    return NETWORK_TEXT.test(e.message) || (cause !== undefined && cause !== e && isChainUnavailable(cause));
  }
  return false;
}
