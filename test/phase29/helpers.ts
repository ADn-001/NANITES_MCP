/** Shared polling helpers for the phase29 async-job suite. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `fn` until it returns a non-null/undefined value or times out. */
export async function waitFor<T>(
  desc: string,
  fn: () => T | null | undefined,
  timeoutMs = 10_000,
  stepMs = 25,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== null && v !== undefined) return v;
    if (Date.now() - start >= timeoutMs) throw new Error(`timed out waiting for: ${desc}`);
    await sleep(stepMs);
  }
}
