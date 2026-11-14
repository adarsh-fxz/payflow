import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const isDev = process.env.NODE_ENV === "development";
/** HTTPS-only headers apply when the app itself is served over https (always true on Vercel). */
const isHttpsApp = isProd && (process.env.NEXT_PUBLIC_APP_URL ?? "https://").startsWith("https://");

function origin(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}
/** The configured RPC is always allowed explicitly, so a local http fork works with `next start`. */
const rpcOrigins = [origin(process.env.NEXT_PUBLIC_MEZO_RPC_URL)].filter(Boolean).join(" ");

/**
 * CSP without nonces (keeps static rendering): Next's inline bootstrap scripts need 'unsafe-inline'
 * and dev HMR needs 'unsafe-eval'. Wallets are reached through the injected provider (extension),
 * and the browser talks to the Mezo RPC over https/wss, so connect-src allows https:/wss:.
 * Org logos are https URLs. Framing is denied everywhere (clickjacking on approve/fund buttons).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' https: wss:${rpcOrigins ? ` ${rpcOrigins}` : ""}${isDev ? " http: ws:" : ""}`,
  // WalletConnect's verify frame (only used when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set).
  "frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isHttpsApp ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ...(isHttpsApp ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
];

const nextConfig: NextConfig = {
  transpilePackages: ["@mezo-org/passport", "@mezo-org/orangekit", "@mezo-org/orangekit-smart-account", "@mezo-org/orangekit-contracts"],
  turbopack: {
    // @coinbase/cdp-sdk (via wagmi connectors) lazily imports x402 packages that this app never uses.
    resolveAlias: {
      "@x402/core/client": "./lib/stubs/empty-module.js",
      "@x402/evm": "./lib/stubs/empty-module.js",
      "@x402/evm/exact/client": "./lib/stubs/empty-module.js",
      "@x402/evm/upto/client": "./lib/stubs/empty-module.js",
      "@x402/svm/exact/client": "./lib/stubs/empty-module.js",
    },
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
