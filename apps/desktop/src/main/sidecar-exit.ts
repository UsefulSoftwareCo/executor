/**
 * Classification of a sidecar child exit that happened AFTER a successful boot.
 *
 * Pure so it can be unit-tested without Electron. Three outcomes, because the
 * three deserve different treatment:
 *
 *   managed-stop      — we asked for it (stopSidecar, or the app is quitting).
 *                       Log it; the UI is going away anyway.
 *   external-shutdown — something outside the app interrupted the child
 *                       (a group SIGINT aimed at Electron is the common one,
 *                       reported by Node as code 130 = 128+SIGINT). The server
 *                       really is gone, so the window must say so, but this is
 *                       a shutdown and not a crash — nothing to report upstream.
 *   crash             — anything else. Reported with the stderr tail.
 *
 * The distinction matters both ways: 130 exits were drowning the crash channel,
 * and a genuine post-boot death has to stay visible in it.
 */

/** Signals that mean "stop", as opposed to "you are broken". */
const SHUTDOWN_SIGNALS: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM", "SIGHUP"]);

/** POSIX 128+N exit codes for those same signals. */
const SHUTDOWN_EXIT_CODES: ReadonlySet<number> = new Set([129, 130, 143]);

export interface SidecarExitInput {
  readonly code: number | null;
  readonly signal: string | null;
  /** True when `stopSidecar` signalled this child (quit, restart, update). */
  readonly stoppedByUs: boolean;
  /** True once Electron has begun quitting. */
  readonly appQuitting: boolean;
}

export type SidecarExitClassification =
  | { readonly kind: "managed-stop"; readonly reason: "stopped-by-app" | "app-quitting" }
  | { readonly kind: "external-shutdown"; readonly reason: string }
  | { readonly kind: "crash" };

export const classifySidecarExit = (input: SidecarExitInput): SidecarExitClassification => {
  if (input.stoppedByUs) return { kind: "managed-stop", reason: "stopped-by-app" };
  if (input.appQuitting) return { kind: "managed-stop", reason: "app-quitting" };
  if (input.signal !== null && SHUTDOWN_SIGNALS.has(input.signal)) {
    return { kind: "external-shutdown", reason: input.signal };
  }
  if (input.code !== null && SHUTDOWN_EXIT_CODES.has(input.code)) {
    return { kind: "external-shutdown", reason: `code ${input.code}` };
  }
  return { kind: "crash" };
};
