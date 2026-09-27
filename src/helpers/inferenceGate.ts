/**
 * Per-profile in-process async serialization gate for sequential-tier profiles
 * (concurrency-hardening CP-4). LM Studio's server slot (`parallel: 1`) stops
 * *server-side* interleaving of one instance, but it cannot serialize callers
 * that each spawn their own load/chat cycle — two overlapping blocking
 * `run_sub_agent` calls on a sequential profile each acquire their own model and
 * run two chats concurrently. This gate guarantees at most one inference is in
 * flight per sequential profile across every entry point, regardless of how
 * callers overlap.
 *
 * Keyed by profile name; a module-singleton promise chain. Parallel-tier
 * profiles never call it (their bounded fan-out is gated by process capacity).
 */
type Release = () => void;

const tails = new Map<string, Promise<void>>();

export function acquireInferenceSlot(profileName: string): Promise<Release> {
  const prior = tails.get(profileName) ?? Promise.resolve();
  let release: Release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The next waiter's tail resolves only once this caller releases.
  tails.set(profileName, prior.then(() => gate));
  return prior.then(() => release);
}

/** Test seam: clear all held gates (only call between fully-drained runs). */
export function resetInferenceGates(): void {
  tails.clear();
}
