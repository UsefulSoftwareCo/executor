import type { Source } from "../types";

/**
 * State configuration for creating, reconnecting, or restoring the current cloud sandbox provider.
 * Used with the unified `connectSandbox()` API.
 */
export interface VercelState {
  /** Where to clone from (omit for empty sandbox or when reconnecting/restoring) */
  source?: Source;
  /** Multiple repositories to clone into subdirectories of the workspace. */
  sources?: Source[];
  /** Durable persistent sandbox name used for reconnecting/resuming sessions */
  sandboxName?: string;
  /** Timestamp (ms) when the current runtime session expires */
  expiresAt?: number;
}
