/**
 * Phase 8 gate — in-process sub-agent concurrency cap (test suite item 8-4).
 * The pool is the hard boundary where the advisory guardrail tier becomes an
 * enforceable limit: acquire up to capacity, refuse beyond it, release frees
 * a slot.
 */
import { describe, expect, it } from "vitest";
import { SubAgentPool } from "../../src/workflows/subAgentPool.js";

describe("SubAgentPool", () => {
  it("acquires up to capacity and refuses beyond it", () => {
    const pool = new SubAgentPool(2);
    expect(pool.tryAcquire()).toBe(true);
    expect(pool.tryAcquire()).toBe(true);
    expect(pool.tryAcquire()).toBe(false);
    expect(pool.activeCount).toBe(2);
    expect(pool.maxCapacity).toBe(2);
  });

  it("release frees a slot", () => {
    const pool = new SubAgentPool(1);
    expect(pool.tryAcquire()).toBe(true);
    pool.release();
    expect(pool.activeCount).toBe(0);
    expect(pool.tryAcquire()).toBe(true);
  });

  it("release below zero is a no-op", () => {
    const pool = new SubAgentPool(2);
    pool.release();
    pool.release();
    expect(pool.activeCount).toBe(0);
    expect(pool.tryAcquire()).toBe(true);
  });

  it("capacity zero refuses everything", () => {
    const pool = new SubAgentPool(0);
    expect(pool.tryAcquire()).toBe(false);
  });
});
