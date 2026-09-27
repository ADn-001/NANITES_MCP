/**
 * Workflow #4 completion: download a model (with backoff polling), and when the
 * download completes, trigger Workflow #1 (run_test_regimen) on it
 * automatically — no manual re-invocation. A download that ends failed/paused/
 * gave_up returns the download result with a null regimen rather than running a
 * test pass against a half-downloaded model.
 */
import type { ToolDeps } from "../tools/deps.js";
import { downloadAndWait, type DownloadWaitOptions, type DownloadWaitResult } from "./downloadAndWait.js";
import { runTestRegimen, type RunRegimenSummary } from "./runTestRegimen.js";

export interface DownloadAndTestResult {
  download: DownloadWaitResult;
  regimen: RunRegimenSummary | null;
}

export async function downloadAndTest(
  deps: ToolDeps,
  profileName: string,
  source: string,
  opts: DownloadWaitOptions = {},
): Promise<DownloadAndTestResult> {
  const download = await downloadAndWait(deps, profileName, source, opts);
  if (download.status !== "completed") {
    return { download, regimen: null };
  }
  const regimen = await runTestRegimen(deps, profileName, source, opts);
  return { download, regimen };
}
