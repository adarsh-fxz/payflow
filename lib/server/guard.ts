/**
 * Runtime guard for server modules. `import "server-only"` is not used because these modules also
 * run in the plain-Node worker and in vitest, where that package throws by design.
 */
if (typeof window !== "undefined") {
  throw new Error("lib/server/* is server-only and must not be imported from client code");
}
export {};
