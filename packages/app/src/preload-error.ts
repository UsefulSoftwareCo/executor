/**
 * Handling for `vite:preloadError` — a route's lazy chunk failing to load.
 *
 * Two very different causes produce the same `TypeError: Failed to fetch
 * dynamically imported module`:
 *
 *   1. The server serving this bundle went away (in the desktop app, the
 *      sidecar exited under a live window). Every subsequent chunk fails too.
 *      Nothing is broken in the app — it is the same event the main process
 *      already surfaces as "server disconnected", so this must show the
 *      reconnect surface and report nothing.
 *   2. The server is up but the chunk hash is stale, because a deploy replaced
 *      the bundle under a long-lived tab. One reload fixes it.
 *
 * A health probe tells them apart. Without this handler the rejection is
 * unhandled, so the user gets a dead route and the crash channel gets a
 * TypeError for what is usually an ordinary shutdown.
 */

export const PRELOAD_ERROR_EVENT = "vite:preloadError";

/** How long to wait between health probes while the server is unreachable. */
const RECONNECT_POLL_MS = 1_000;

export interface PreloadErrorEnvironment {
  readonly target: EventTarget;
  /** Resolves true when the server answers its health endpoint. */
  readonly probeServer: () => Promise<boolean>;
  /** Render the "lost connection, reconnecting" surface. */
  readonly showDisconnected: () => void;
  readonly reload: () => void;
  /** Report a chunk failure that a reload could not resolve. */
  readonly report: (error: unknown) => void;
  /** Has this session already spent its one automatic reload? */
  readonly readReloadFlag: () => boolean;
  readonly writeReloadFlag: () => void;
  readonly delay: (ms: number) => Promise<void>;
}

export type PreloadErrorOutcome =
  /** Server was down; waited for it and reloaded once it answered. */
  | "reconnected"
  /** Server was up, so the chunk was stale; reloaded once. */
  | "reloaded"
  /** A reload already happened this session and did not help; reported. */
  | "reported";

export const respondToPreloadError = async (
  env: PreloadErrorEnvironment,
  error: unknown,
): Promise<PreloadErrorOutcome> => {
  if (await env.probeServer()) {
    // The origin answers, so this is a stale chunk rather than a dead server.
    // Exactly one reload per session, so a chunk that stays missing cannot
    // turn into a reload loop — it gets reported instead.
    if (env.readReloadFlag()) {
      env.report(error);
      return "reported";
    }
    env.writeReloadFlag();
    env.reload();
    return "reloaded";
  }

  env.showDisconnected();
  for (;;) {
    await env.delay(RECONNECT_POLL_MS);
    if (await env.probeServer()) {
      env.reload();
      return "reconnected";
    }
  }
};

/** Vite dispatches the failure as `CustomEvent<{ payload: Error }>`. */
const preloadErrorPayload = (event: Event): unknown =>
  (event as CustomEvent<{ readonly payload?: unknown }>).detail?.payload;

/** Registers the handler; returns a disposer. */
export const installPreloadErrorHandler = (env: PreloadErrorEnvironment): (() => void) => {
  const handler = (event: Event) => {
    // Always claim the event: Vite rethrows an unclaimed preload error into the
    // page as an unhandled rejection, which is the crash report we are here to
    // replace with a real recovery path.
    event.preventDefault();
    void respondToPreloadError(env, preloadErrorPayload(event));
  };
  env.target.addEventListener(PRELOAD_ERROR_EVENT, handler);
  return () => env.target.removeEventListener(PRELOAD_ERROR_EVENT, handler);
};
