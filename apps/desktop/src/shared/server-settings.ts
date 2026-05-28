/**
 * Persistent desktop sidecar settings, edited from the renderer's Settings
 * page and consumed by the main process when spawning the sidecar.
 *
 * The shape lives in `src/shared/` because both main (IPC handlers) and
 * renderer (Settings UI + Connect-an-agent surface) need to agree on it.
 */

import type { ExecutorServerConnection } from "@executor-js/sdk/shared";

export interface DesktopServerSettings {
  /** TCP port the sidecar listens on. Default 4789. */
  readonly port: number;
  /**
   * Whether the sidecar enforces HTTP Basic auth on every request.
   * When false, the sidecar relies on the host allowlist alone.
   */
  readonly requireAuth: boolean;
  /**
   * Basic auth password the sidecar enforces and the renderer exposes
   * via `window.executor`. Persisted across launches so AI client MCP
   * configs stay valid until the user regenerates.
   */
  readonly password: string;
}

export type DesktopServerConnection = ExecutorServerConnection & {
  readonly kind: "desktop-sidecar";
  readonly key: "desktop-sidecar";
  readonly auth?: {
    readonly kind: "basic";
    readonly username: string;
    readonly password: string;
  };
};

export const DEFAULT_SERVER_SETTINGS: DesktopServerSettings = {
  port: 4789,
  requireAuth: true,
  password: "",
};

export const SERVER_SETTINGS_USERNAME = "executor";
