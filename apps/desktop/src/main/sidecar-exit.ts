/**
 * Pure classification of a sidecar's *post-boot* exit (the child died after it
 * had already reported ready). Kept free of electron/log imports so the rule is
 * unit-testable in isolation — `sidecar.ts` owns the I/O around it.
 *
 * The trap this guards against: the desktop only marks an exit "expected" when
 * it stopped the child itself via `stopSidecar` (which sends SIGTERM). A signal
 * that arrives any other way — most commonly a process-group SIGINT racing
 * ahead of teardown — would otherwise be filed as a crash, painting the crash
 * screen over (and Sentry-reporting) what was really a clean shutdown.
 *
 * Classification is on the exit code/signal alone — the OS's verdict on whether
 * the process ended normally. We deliberately do NOT inspect stderr: the buffer
 * is a rolling tail of the whole session (a startup log line would make it
 * non-empty), so it is a poor proxy for "errored at exit". A genuine internal
 * fault in the daemon is reported with a real stack by the sidecar's own
 * crash reporter (@sentry/bun, see sidecar/server.ts); this main-process path
 * is only the coarse "the child vanished" net, so it should fire on abnormal
 * exits and stay quiet on clean ones.
 */

// Exit codes a process reports when it shuts down through its own handler:
// 0 is a graceful success; 130 = 128 + SIGINT(2) and 143 = 128 + SIGTERM(15)
// are the conventional codes an interrupted program exits with (an Effect
// `runMain` program interrupted by SIGINT exits 130).
const CLEAN_SHUTDOWN_EXIT_CODES: ReadonlySet<number> = new Set([0, 130, 143]);

// When no handler runs, the process dies on the raw signal instead and Node
// reports the signal name with a null code. SIGINT/SIGTERM are orderly stop
// requests; SIGKILL/SIGSEGV/etc. are not and fall through to "crash".
const CLEAN_SHUTDOWN_SIGNALS: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM"]);

export type PostBootSidecarExitDecision =
  /** We asked it to stop, or the app is quitting — say nothing, do nothing. */
  | { readonly kind: "expected" }
  /**
   * A graceful or signal-driven exit (code 0/130/143, or a raw SIGINT/SIGTERM)
   * that bypassed `stopSidecar`. The web UI is dead so the recovery screen still
   * has to show, but this is a healthy shutdown and must not be reported.
   */
  | { readonly kind: "recover" }
  /** A genuine fault (abnormal exit / hard kill): surface recovery UI *and* report. */
  | { readonly kind: "crash" };

export const classifyPostBootSidecarExit = (input: {
  /** The child was passed to `stopSidecar` (we initiated this stop). */
  readonly expected: boolean;
  /** `before-quit` has fired — the whole app is tearing down. */
  readonly appQuitting: boolean;
  readonly code: number | null;
  readonly signal: string | null;
}): PostBootSidecarExitDecision => {
  if (input.expected || input.appQuitting) return { kind: "expected" };
  const cleanShutdown =
    (input.code !== null && CLEAN_SHUTDOWN_EXIT_CODES.has(input.code)) ||
    (input.signal !== null && CLEAN_SHUTDOWN_SIGNALS.has(input.signal));
  return cleanShutdown ? { kind: "recover" } : { kind: "crash" };
};
