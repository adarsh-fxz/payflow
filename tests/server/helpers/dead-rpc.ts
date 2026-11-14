// Imported FIRST (before helpers/env) by outage tests: points the chain config at a closed port.
process.env.NEXT_PUBLIC_MEZO_RPC_URL = "http://127.0.0.1:9";
process.env.CHAIN_RPC_TIMEOUT_MS = "1500";
export {};
