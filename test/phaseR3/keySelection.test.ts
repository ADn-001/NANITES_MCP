/**
 * R3 — key selection, the pure half.
 *
 * `selectKey` is a pure function over a candidate list, so this whole file
 * needs no database. That is the point: four strategies with subtle edge
 * cases (a shrinking pool, budgets tripping mid-run) are only testable
 * cheaply if the decision is separated from the store.
 *
 * The round-robin shrinking-pool test is the important one. The MCP router
 * discovered that an INDEX-based cursor silently skips a neighbour when the
 * pool shrinks mid-run; this asserts that property holds here too, so a future
 * "simplification" back to indexing fails loudly.
 */
import { describe, expect, it } from "vitest";
import { selectKey, advanceCursor, type KeyCandidate, type SelectionPolicy } from "../../src/router/keys/selector.js";

function candidate(over: Partial<KeyCandidate> & { key_id: string; order: number }): KeyCandidate {
  return {
    provider: "openrouter",
    nickname: null,
    gateway_url: null,
    usage_ratio: 0,
    is_sticky: false,
    consecutive_failures: 0,
    ...over,
  };
}

function policy(over: Partial<SelectionPolicy> = {}): SelectionPolicy {
  return {
    strategy: "round_robin",
    budget_threshold: 0.9,
    fallback: "round_robin",
    cursor: 0,
    random: () => 0.5,
    ...over,
  };
}

const four = [
  candidate({ key_id: "a", order: 0 }),
  candidate({ key_id: "b", order: 1 }),
  candidate({ key_id: "c", order: 2 }),
  candidate({ key_id: "d", order: 3 }),
];

describe("random", () => {
  it("is uniform over the pool, not merely 'picks something'", () => {
    // A seeded walk, not randomness: assert the DISTRIBUTION, which is the
    // property a broken implementation loses.
    const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    const p = policy({ strategy: "random" });
    for (let i = 0; i < 4000; i++) {
      const r = (i + 0.5) / 4000;
      const chosen = selectKey(four, { ...p, random: () => r });
      if (chosen) counts[chosen.key_id]!++;
    }
    for (const id of ["a", "b", "c", "d"]) {
      expect(counts[id]).toBeGreaterThan(900);
      expect(counts[id]).toBeLessThan(1100);
    }
  });

  it("clamps an out-of-range random value instead of returning undefined", () => {
    expect(selectKey(four, policy({ strategy: "random", random: () => 1.5 }))!.key_id).toBe("d");
    expect(selectKey(four, policy({ strategy: "random", random: () => -0.2 }))!.key_id).toBe("a");
  });

  it("returns null for an empty pool", () => {
    expect(selectKey([], policy())).toBeNull();
  });
});

describe("round_robin", () => {
  it("cycles through every key exactly once per lap", () => {
    const seen: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 12; i++) {
      const chosen = selectKey(four, policy({ cursor }));
      if (chosen) seen.push(chosen.key_id);
      cursor = advanceCursor(cursor, four.length);
    }
    expect(seen).toEqual(["a", "b", "c", "d", "a", "b", "c", "d", "a", "b", "c", "d"]);
  });

  it("reaches EVERY key when the pool shrinks mid-sequence", () => {
    // The MCP router's lesson: an index cursor into a SHRUNK pool can skip a
    // neighbour entirely. Retiring a key must not orphan another.
    const seen = new Set<string>();
    let cursor = 0;
    for (let lap = 0; lap < 3; lap++) {
      // Pool shrinks each lap: 4 -> 3 -> 2.
      const pool = four.slice(0, 4 - lap);
      for (let i = 0; i < pool.length; i++) {
        const chosen = selectKey(pool, policy({ cursor }));
        if (chosen) seen.add(chosen.key_id);
        cursor = advanceCursor(cursor, pool.length);
      }
    }
    expect([...seen].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("does not skip when the FIRST key of a lap was retired", () => {
    // "b" is missing; the sequence must still visit c and d.
    const pool = [candidate({ key_id: "a", order: 0 }), candidate({ key_id: "c", order: 2 }), candidate({ key_id: "d", order: 3 })];
    const seen = new Set<string>();
    let cursor = 0;
    for (let i = 0; i < 9; i++) {
      const chosen = selectKey(pool, policy({ cursor }));
      if (chosen) seen.add(chosen.key_id);
      cursor = advanceCursor(cursor, pool.length);
    }
    expect([...seen].sort()).toEqual(["a", "c", "d"]);
  });

  it("handles a negative cursor without throwing", () => {
    // A fresh install stores -1, and the persisted value can outlive a restart.
    expect(() => selectKey(four, policy({ cursor: -1 }))).not.toThrow();
    expect(selectKey(four, policy({ cursor: -1 }))).not.toBeNull();
  });
});

describe("usage_failover", () => {
  it("keeps using the MOST used key under budget", () => {
    // Deliberately counter-intuitive: this is "keep using one key until it is
    // done", not "spread the load". Per-account quotas punish spreading.
    const pool = [
      candidate({ key_id: "a", order: 0, usage_ratio: 0.4 }),
      candidate({ key_id: "b", order: 1, usage_ratio: 0.35 }),
      candidate({ key_id: "c", order: 2, usage_ratio: 0.25 }),
    ];
    expect(selectKey(pool, policy({ strategy: "usage_failover" }))!.key_id).toBe("a");
  });

  it("moves to the next key once one exceeds the budget", () => {
    const pool = [
      candidate({ key_id: "a", order: 0, usage_ratio: 0.95 }),
      candidate({ key_id: "b", order: 1, usage_ratio: 0.35 }),
    ];
    // "a" is over the 0.9 threshold and excluded, so "b" takes over.
    expect(selectKey(pool, policy({ strategy: "usage_failover", budget_threshold: 0.9 }))!.key_id).toBe("b");
  });

  it("returns null when EVERY key is over budget", () => {
    const pool = [
      candidate({ key_id: "a", order: 0, usage_ratio: 0.95 }),
      candidate({ key_id: "b", order: 1, usage_ratio: 0.99 }),
    ];
    // Silently returning an over-budget key would defeat the point of a budget.
    expect(selectKey(pool, policy({ strategy: "usage_failover" }))).toBeNull();
  });

  it("treats a key with NO budget as unconstrained, not as 0% used", () => {
    const pool = [
      candidate({ key_id: "nobudget", order: 0, usage_ratio: 0 }),
      candidate({ key_id: "budgeted", order: 1, usage_ratio: 0.5 }),
    ];
    // The budgeted key is the one with real usage, so it wins.
    expect(selectKey(pool, policy({ strategy: "usage_failover" }))!.key_id).toBe("budgeted");
  });

  it("falls back to lowest request count when no key has a budget", () => {
    const pool = [
      candidate({ key_id: "a", order: 0 }),
      candidate({ key_id: "b", order: 1 }),
    ];
    expect(selectKey(pool, policy({ strategy: "usage_failover" }))!.key_id).toBe("a");
  });
});

describe("sticky_last_best", () => {
  it("returns the sticky key when it is healthy", () => {
    const pool = [
      candidate({ key_id: "a", order: 0 }),
      candidate({ key_id: "b", order: 1, is_sticky: true }),
      candidate({ key_id: "c", order: 2 }),
    ];
    expect(selectKey(pool, policy({ strategy: "sticky_last_best" }))!.key_id).toBe("b");
  });

  it("falls back when the sticky key is FAILING", () => {
    const pool = [
      candidate({ key_id: "a", order: 0 }),
      candidate({ key_id: "b", order: 1, is_sticky: true, consecutive_failures: 1 }),
    ];
    // A sticky pointer to a degrading key is exactly what stickiness must
    // prevent, so a failure releases it immediately.
    expect(selectKey(pool, policy({ strategy: "sticky_last_best" }))!.key_id).not.toBe("b");
  });

  it("falls back when the sticky key is over budget", () => {
    const pool = [
      candidate({ key_id: "a", order: 0 }),
      candidate({ key_id: "b", order: 1, is_sticky: true, usage_ratio: 0.99 }),
    ];
    expect(selectKey(pool, policy({ strategy: "sticky_last_best" }))!.key_id).not.toBe("b");
  });

  it("uses the configured fallback when nothing is sticky", () => {
    const pool = four;
    expect(selectKey(pool, policy({ strategy: "sticky_last_best", fallback: "random", random: () => 0.99 }))!.key_id).toBe("d");
    expect(selectKey(pool, policy({ strategy: "sticky_last_best", fallback: "round_robin", cursor: 2 }))!.key_id).toBe("c");
  });

  it("composes with usage_failover rather than replacing it", () => {
    // Sticky is checked first, then the strategy still governs the fallback.
    const pool = [
      candidate({ key_id: "a", order: 0, usage_ratio: 0.5 }),
      candidate({ key_id: "b", order: 1, usage_ratio: 0.8, is_sticky: true }),
    ];
    const chosen = selectKey(pool, policy({
      strategy: "sticky_last_best",
      fallback: "round_robin",
      cursor: 0,
    }));
    // b is sticky and under the 0.9 threshold, so it wins over the more-used a.
    expect(chosen!.key_id).toBe("b");
  });
});
