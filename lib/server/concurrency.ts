import "./guard";

/** Runs fn over xs with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(xs: readonly T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, xs.length)) }, async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
