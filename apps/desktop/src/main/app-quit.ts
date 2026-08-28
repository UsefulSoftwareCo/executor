/**
 * Shared "is the app on its way out?" flag for the main process.
 *
 * Teardown makes several failures expected rather than exceptional: a sidecar
 * child dying, a navigation aborting mid-load. Both the sidecar and window code
 * need the same answer, so the flag lives here instead of being threaded
 * through either. Listeners are registered at import time (Electron accepts
 * `app.on` before ready) so no caller can forget to arm it.
 */

import { app } from "electron";

let quitting = false;

const markQuitting = () => {
  quitting = true;
};

app.on("before-quit", markQuitting);
app.on("will-quit", markQuitting);
app.on("quit", markQuitting);

export const isAppQuitting = (): boolean => quitting;
