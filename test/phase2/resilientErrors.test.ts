import { describe, expect, it } from "vitest";
import { handleFailure, RECOVERY_POLICIES, type FailureMode } from "../../src/helpers/resilientErrors.js";
import { NanitesError } from "../../src/helpers/errors.js";

const trigger: Record<FailureMode, unknown> = {
  unreachable: new NanitesError({ code: "connection_refused", message: "refused", retryable: true }),
  model_load_failure: new NanitesError({ code: "http_server_error", message: "500", retryable: true }),
  midcall_disconnect: new NanitesError({ code: "truncated_stream", message: "cut", retryable: true }),
  stalled_download: { status: "stalled" as const },
  failed_download: { status: "failed" as const },
};

describe("handleFailure — table-driven over documented failure modes", () => {
  for (const mode of Object.keys(RECOVERY_POLICIES) as FailureMode[]) {
    it(`maps ${mode} to a structured error + documented recovery policy`, () => {
      const raw = trigger[mode] as unknown;
      const status = raw instanceof NanitesError ? undefined : (raw as { status: "stalled" | "failed" });
      const { error, policy } = status ? handleFailure(null, status) : handleFailure(raw);

      // Structured error shape — never a raw throw.
      expect(typeof error.code).toBe("string");
      expect(typeof error.message).toBe("string");
      expect(typeof error.retryable).toBe("boolean");

      // Policy is the documented one for this mode.
      expect(policy.mode).toBe(mode);
      expect(policy.recovery.length).toBeGreaterThan(10);
      expect(typeof policy.escalate).toBe("boolean");

      // Error and policy agree on retryability.
      expect(error.retryable).toBe(policy.retryable);
    });
  }

  it("classifies a stuck download as stalled_download", () => {
    const { policy } = handleFailure(null, { status: "stalled" });
    expect(policy.recovery.toLowerCase()).toContain("poll");
  });

  it("classifies a failed download as failed_download and escalates", () => {
    const { error, policy } = handleFailure(null, { status: "failed" });
    expect(error.code).toBe("failed_download");
    expect(policy.escalate).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("wraps unexpected non-Nanites errors instead of leaking them", () => {
    const { error, policy } = handleFailure(new Error("boom"));
    expect(error.code).toBe("unexpected_error");
    expect(error.retryable).toBe(false);
    expect(policy.mode).toBe("failed_download");
  });

  it("every policy carries a distinct mode and a non-empty recovery string", () => {
    const modes = Object.values(RECOVERY_POLICIES).map((p) => p.mode);
    expect(new Set(modes).size).toBe(modes.length);
    for (const policy of Object.values(RECOVERY_POLICIES)) {
      expect(policy.recovery.trim().length).toBeGreaterThan(0);
    }
  });
});
