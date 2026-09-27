/**
 * In-process concurrency guard for sub-agent spawns, sized to the active
 * profile's guardrail tier (max_parallel_models). A spawn that would exceed
 * capacity is refused with a structured, retryable error — the caller decides
 * whether to wait/queue. Advisory tiering becomes a hard cap only at this
 * boundary; the skill still explains why.
 */
export class SubAgentPool {
  private active = 0;

  constructor(private readonly capacity: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.capacity) return false;
    this.active++;
    return true;
  }

  release(): void {
    if (this.active > 0) this.active--;
  }

  get activeCount(): number {
    return this.active;
  }

  get maxCapacity(): number {
    return this.capacity;
  }
}
