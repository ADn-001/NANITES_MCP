/**
 * Phase 9 gate — download polling with backoff (test suite item 3). Backoff
 * timings must increase between polls (never a fixed tight interval), and
 * polling must stop on a terminal status rather than continuing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createDownloadHarness, type DownloadHarness } from "./helpers.js";

const SOURCE = "lmstudio-community/gemma-3-270m-it-qat";

describe("Phase 9 gate — download_and_wait", () => {
  let h: DownloadHarness;

  afterEach(async () => {
    await h.close();
  });

  it("polls until completed and records increasing backoffs", async () => {
    h = await createDownloadHarness({ downloadStatuses: ["downloading", "downloading", "downloading", "completed"] });
    const res = await h.wait(SOURCE, { baseBackoffMs: 1000, backoffMultiplier: 2 });
    expect(res.status).toBe("completed");
    expect(res.job_id).toBe("job_493c7c9ded");
    expect(res.polls).toBe(4);
    expect(h.counts.statusPolls).toBe(4);
    // [0, 1000, 2000, 4000]: exponential, strictly increasing, not a fixed interval.
    expect(res.backoffs).toEqual([0, 1000, 2000, 4000]);
    expect(res.backoffs[1]! > res.backoffs[0]!).toBe(true);
    expect(res.backoffs[3]! > res.backoffs[2]!).toBe(true);
  });

  it("stops on failed", async () => {
    h = await createDownloadHarness({ downloadStatuses: ["downloading", "failed"] });
    const res = await h.wait(SOURCE);
    expect(res.status).toBe("failed");
    expect(res.polls).toBe(2);
  });

  it("stops on paused", async () => {
    h = await createDownloadHarness({ downloadStatuses: ["downloading", "paused"] });
    const res = await h.wait(SOURCE);
    expect(res.status).toBe("paused");
    expect(res.polls).toBe(2);
  });

  it("already_downloaded returns completed without polling", async () => {
    h = await createDownloadHarness({ alreadyDownloaded: true });
    const res = await h.wait(SOURCE);
    expect(res.status).toBe("completed");
    expect(res.polls).toBe(0);
    expect(h.counts.statusPolls).toBe(0);
  });

  it("a job that never terminates gives up after the poll ceiling", async () => {
    h = await createDownloadHarness({ downloadStatuses: ["downloading"] });
    const res = await h.wait(SOURCE, { maxPolls: 3 });
    expect(res.status).toBe("gave_up");
    expect(res.polls).toBe(3);
    expect(h.counts.statusPolls).toBe(3);
  });

  it("quantization is passed through to the download request", async () => {
    h = await createDownloadHarness();
    const res = await h.wait(SOURCE, { quantization: "Q4_K_M" });
    expect(res.quantization).toBe("Q4_K_M");
    expect((h.lastDownloadBody as { model: string; quantization: string }).model).toBe(SOURCE);
    expect((h.lastDownloadBody as { model: string; quantization: string }).quantization).toBe("Q4_K_M");
  });
});
