/**
 * In-process concurrency guard for sub-agent spawns, sized to the active
 * profile's guardrail tier (max_parallel_models). A spawn that would exceed
 * capacity is refused with a structured, retryable error — the caller decides
 * whether to wait/queue. Advisory tiering becomes a hard cap only at this
 * boundary; the skill still explains why.
 */
export class SubAgentPool {
    capacity;
    active = 0;
    constructor(capacity) {
        this.capacity = capacity;
    }
    tryAcquire() {
        if (this.active >= this.capacity)
            return false;
        this.active++;
        return true;
    }
    release() {
        if (this.active > 0)
            this.active--;
    }
    get activeCount() {
        return this.active;
    }
    get maxCapacity() {
        return this.capacity;
    }
}
