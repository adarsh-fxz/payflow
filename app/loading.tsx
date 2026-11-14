export default function Loading() {
  return (
    <div role="status" aria-label="Loading" className="mx-auto w-full max-w-6xl flex-1 px-4 py-16 sm:px-6">
      <div className="h-8 w-64 animate-pulse rounded-md bg-muted" />
      <div className="mt-4 h-4 w-96 max-w-full animate-pulse rounded bg-muted" />
      <div className="mt-10 h-48 w-full animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
