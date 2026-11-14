export default function Loading() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-1 justify-center bg-surface px-4 py-16">
      <div className="h-96 w-full max-w-md animate-pulse rounded-xl border bg-card" />
    </div>
  );
}
