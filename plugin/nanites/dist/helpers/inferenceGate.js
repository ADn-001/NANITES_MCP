const tails = new Map();
export function acquireInferenceSlot(profileName) {
    const prior = tails.get(profileName) ?? Promise.resolve();
    let release = () => { };
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    // The next waiter's tail resolves only once this caller releases.
    tails.set(profileName, prior.then(() => gate));
    return prior.then(() => release);
}
/** Test seam: clear all held gates (only call between fully-drained runs). */
export function resetInferenceGates() {
    tails.clear();
}
