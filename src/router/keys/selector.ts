/**
 * Key selection.
 *
 * A PURE function over a candidate list — no store access, no I/O, no clock
 * beyond the `now` passed in. That is what makes all four strategies testable
 * without a database, and it is the reason this is separate from the store.
 *
 * The strategies are about PREFERENCE, not eligibility. Whether a key can be
 * used at all is `ProviderKeyStore.availableKeys`; this decides which of the
 * eligible ones to use.
 */

export type KeyStrategy = "random" | "round_robin" | "usage_failover" | "sticky_last_best";

export interface KeyCandidate {
  key_id: string;
  provider: string;
  nickname: string | null;
  gateway_url: string | null;
  /** 0..1 of this key's own budget. 0 means no budget configured. */
  usage_ratio: number;
  /** True when router_sticky points at this key for the model in question. */
  is_sticky: boolean;
  consecutive_failures: number;
  /** Ordinal position, used only by round_robin's persisted cursor. */
  order: number;
}

export interface SelectionPolicy {
  strategy: KeyStrategy;
  /** usage_failover: ratio at which a key is treated as spent. */
  budget_threshold: number;
  /** Fallback when the strategy has no preference. */
  fallback: "random" | "round_robin";
  /** The persisted round-robin cursor position. */
  cursor: number;
  /** Injected for deterministic tests. */
  random: () => number;
}

/** A key is over budget when it has one configured and exceeds the threshold. */
function isSpent(c: KeyCandidate, policy: SelectionPolicy): boolean {
  return c.usage_ratio > 0 && c.usage_ratio >= policy.budget_threshold;
}

export function selectKey(
  candidates: KeyCandidate[],
  policy: SelectionPolicy,
): KeyCandidate | null {
  if (candidates.length === 0) return null;

  // Sticky is a PREFERENCE, checked before the strategy. It composes with the
  // other three rather than replacing them: when the sticky key is unavailable
  // the configured strategy still decides.
  if (policy.strategy === "sticky_last_best") {
    const sticky = candidates.find((c) => c.is_sticky && !isSpent(c, policy) && c.consecutive_failures === 0);
    if (sticky) return sticky;
    return byFallback(candidates, policy);
  }

  if (policy.strategy === "random") {
    return randomPick(candidates, policy.random);
  }

  if (policy.strategy === "round_robin") {
    return roundRobin(candidates, policy);
  }

  // usage_failover: the MOST used key that is still under budget.
  //
  // Counter-intuitive on purpose. The behaviour the user asked for is "keep
  // using one key until it is done", and providers with per-ACCOUNT quotas
  // punish spreading — saturating one account and moving on beats round-robining
  // across three, each of which then looks barely used and none of which gets
  // to its limit cleanly. So this picks the most-consumed eligible key rather
  // than the least.
  const eligible = candidates.filter((c) => !isSpent(c, policy));
  if (eligible.length === 0) return null;

  const withBudget = eligible.filter((c) => c.usage_ratio > 0);
  if (withBudget.length > 0) {
    // Most used wins. `order` breaks ties so the result is deterministic.
    return withBudget.reduce((a, b) => (b.usage_ratio > a.usage_ratio || (b.usage_ratio === a.usage_ratio && b.order < a.order) ? b : a));
  }
  // No budget on any key: the fewest requests is the least surprising default,
  // and it is a real signal rather than an arbitrary one.
  return eligible.reduce((a, b) => (b.order < a.order ? b : a));
}

function byFallback(candidates: KeyCandidate[], policy: SelectionPolicy): KeyCandidate | null {
  if (policy.fallback === "round_robin") return roundRobin(candidates, policy);
  return randomPick(candidates, policy.random);
}

function randomPick(candidates: KeyCandidate[], random: () => number): KeyCandidate {
  const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)));
  return candidates[index]!;
}

/**
 * Round-robin over the CURRENT candidate set.
 *
 * The cursor is a position, not a key identity, because the pool changes: a
 * key can be retired mid-run. The modulo is written to handle a shrunken pool
 * without skipping a neighbour or throwing on an out-of-range cursor.
 */
function roundRobin(candidates: KeyCandidate[], policy: SelectionPolicy): KeyCandidate {
  const count = candidates.length;
  const start = ((policy.cursor % count) + count) % count;
  return candidates[start]!;
}

/** The next cursor value after selecting from a pool of this size. */
export function advanceCursor(cursor: number, count: number): number {
  if (count <= 0) return cursor;
  return cursor + 1;
}
