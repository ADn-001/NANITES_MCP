import { downloadAndWait } from "./downloadAndWait.js";
import { runTestRegimen } from "./runTestRegimen.js";
export async function downloadAndTest(deps, profileName, source, opts = {}) {
    const download = await downloadAndWait(deps, profileName, source, opts);
    if (download.status !== "completed") {
        return { download, regimen: null };
    }
    const regimen = await runTestRegimen(deps, profileName, source, opts);
    return { download, regimen };
}
