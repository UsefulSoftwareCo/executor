/**
 * Persistent desktop sidecar settings, edited from the renderer's Settings
 * page and consumed by the main process when spawning the sidecar.
 *
 * The shape lives in `src/shared/` because both main (IPC handlers) and
 * renderer (Settings UI + Connect-an-agent surface) need to agree on it.
 *
 * Auth is NOT a setting: the sidecar always enforces the locally-minted bearer
 * token (see `~/.executor/server-control/auth.json`). The main process injects it into
 * the webview transparently, so the renderer never sees the credential and
 * there is nothing to toggle or persist here.
 */

import type { ExecutorServerConnection } from "@executor-js/sdk/shared";

export interface DesktopServerSettings {
  /** TCP port the sidecar listens on. Default 4789. */
  readonly port: number;
}

/**
 * The connection the renderer receives. Auth is intentionally absent — the main
 * process injects the bearer header at the session layer, so the credential
 * never crosses the IPC boundary.
 */
export type DesktopServerConnection = ExecutorServerConnection & {
  readonly kind: "desktop-sidecar";
  readonly key: "desktop-sidecar";
};

export const DEFAULT_SERVER_SETTINGS: DesktopServerSettings = {
  port: 4789,
};

export const SERVER_SETTINGS_USERNAME = "executor";
