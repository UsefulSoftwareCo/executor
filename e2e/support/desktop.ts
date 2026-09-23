import type { ElectronApplication } from "playwright";
import { driver } from "./platform.ts";

/** Request a browser link across Electron's real session boundary, without an API key. */
export const requestBrowserPairing = (electron: ElectronApplication, origin: string) =>
  driver("pair from the native desktop session", () =>
    electron.evaluate(({ session }, origin) => {
      return session
        .fromPartition("executor-desktop")
        .fetch(`${origin}/auth/pair`, {
          method: "POST",
          credentials: "include",
          headers: { origin },
          redirect: "error",
        })
        .then((response) => response.json().then((body) => ({ status: response.status, body })));
    }, origin),
  );
