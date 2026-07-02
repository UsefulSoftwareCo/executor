// Renderer view of the desktop auto-update status the Electron main process
// exposes on `window.executor` (see apps/desktop/src/shared/update.ts for the
// wire contract and apps/desktop/src/preload for the bridge). On web and
// CLI-served installs there is no bridge, so `useDesktopUpdate` returns null and
// the shell falls back to its npm UpdateCard. In the desktop app it drives a
// native "Restart to update" card instead, because desktop updates ship as a
// new bundle via electron-updater, not `npm i -g`.
import { useEffect, useMemo, useState } from "react";

export type DesktopUpdateStatus =
  | { readonly state: "idle" }
  | { readonly state: "available"; readonly version: string }
  | { readonly state: "downloading"; readonly version: string; readonly percent: number }
  | { readonly state: "downloaded"; readonly version: string }
  | { readonly state: "installing"; readonly version: string };

type DesktopUpdateBridge = {
  getUpdateStatus: () => Promise<DesktopUpdateStatus>;
  onUpdateStatus: (cb: (status: DesktopUpdateStatus) => void) => () => void;
  installUpdate: () => Promise<void>;
};

const getDesktopUpdateBridge = (): DesktopUpdateBridge | null => {
  if (typeof window === "undefined") return null;
  const candidate = (window as { readonly executor?: Partial<DesktopUpdateBridge> }).executor;
  if (
    candidate &&
    typeof candidate.getUpdateStatus === "function" &&
    typeof candidate.onUpdateStatus === "function" &&
    typeof candidate.installUpdate === "function"
  ) {
    // oxlint-disable-next-line executor/no-double-cast -- boundary: narrowed by the typeof guards above
    return candidate as DesktopUpdateBridge;
  }
  return null;
};

export interface DesktopUpdate {
  readonly status: DesktopUpdateStatus;
  /** Apply a downloaded update and restart the app. */
  readonly install: () => void;
}

/**
 * Subscribe to the desktop app's auto-update status. Returns null when not
 * running inside the desktop bridge (web / CLI-served), so the caller can fall
 * back to its npm upgrade card. Hook order is stable: the bridge is resolved
 * once and the subscription effect always runs.
 */
export function useDesktopUpdate(): DesktopUpdate | null {
  const bridge = useMemo(() => getDesktopUpdateBridge(), []);
  const [status, setStatus] = useState<DesktopUpdateStatus>({ state: "idle" });

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    // The initial snapshot is an async IPC round-trip; a push (e.g. download
    // finished) can land first. Never let the stale snapshot overwrite a push
    // that already arrived.
    let receivedPush = false;
    void bridge.getUpdateStatus().then((current) => {
      if (active && !receivedPush) setStatus(current);
    });
    const unsubscribe = bridge.onUpdateStatus((next) => {
      receivedPush = true;
      setStatus(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  if (!bridge) return null;
  return { status, install: () => void bridge.installUpdate() };
}
