/**
 * Browser wiring for the "server went away" recovery path.
 *
 * Owns the DOM half that `preload-error.ts` deliberately does not: the health
 * probe against the origin serving this bundle, and the reconnect overlay shown
 * while it is unreachable. The overlay is plain DOM with inline styles rather
 * than a React surface because it has to render when the app's own route chunks
 * can no longer be fetched.
 */

import { installPreloadErrorHandler, type PreloadErrorEnvironment } from "./preload-error";

const OVERLAY_ID = "executor-server-disconnected";
const RELOAD_FLAG_KEY = "executor:preload-reloaded";

/** The unauthenticated health endpoint every Executor server exposes. */
const probeServer = async (): Promise<boolean> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-raw-fetch -- boundary: fetch rejects when the server is down, which is precisely the signal being read
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    return response.ok && (await response.text()).trim() === "ok";
  } catch {
    return false;
  }
};

const showDisconnectedOverlay = (): void => {
  if (document.getElementById(OVERLAY_ID)) return;
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "display:grid",
    "place-items:center",
    "gap:0.5rem",
    "background:light-dark(#f7f7f4,#0a0a0a)",
    "color:light-dark(#18181b,#fafafa)",
    "color-scheme:light dark",
    "font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "text-align:center",
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "Lost connection to the Executor server";
  title.style.cssText = "font-size:0.95rem;font-weight:600";

  const detail = document.createElement("div");
  detail.textContent = "RECONNECTING…";
  detail.style.cssText = [
    "font-family:ui-monospace,SFMono-Regular,Menlo,monospace",
    "font-size:0.72rem",
    "letter-spacing:0.08em",
    "opacity:0.6",
  ].join(";");

  const stack = document.createElement("div");
  stack.style.cssText = "display:grid;gap:0.5rem;justify-items:center";
  stack.append(title, detail);
  overlay.append(stack);
  document.body.append(overlay);
};

const sessionFlag = (): Pick<Storage, "getItem" | "setItem"> | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: sessionStorage throws when storage is blocked or full
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/**
 * The real browser half of the environment `respondToPreloadError` consumes.
 * Exported so a test can check the mapping itself — an inverted probe or a
 * reload guard that never latches would leave every behavioural test green
 * while the app reload-loops.
 */
export const browserEnvironment = (): PreloadErrorEnvironment => {
  const storage = sessionFlag();
  return {
    target: window,
    probeServer,
    showDisconnected: showDisconnectedOverlay,
    reload: () => window.location.reload(),
    // Routed through the same reporter the rest of the UI uses, so a chunk that
    // stays missing with a healthy server is still visible upstream.
    report: (error) => globalThis.reportError?.(error),
    // Without storage the guard degrades to "never auto-reload", which is the
    // safe direction: a missing chunk gets reported instead of looping.
    readReloadFlag: () => (storage ? storage.getItem(RELOAD_FLAG_KEY) !== null : true),
    writeReloadFlag: () => storage?.setItem(RELOAD_FLAG_KEY, "1"),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
};

/**
 * Install the preload-error recovery path. Safe to call outside a browser
 * (SSR/tests), where it is a no-op.
 */
export const installServerDisconnectedRecovery = (): void => {
  if (typeof window === "undefined") return;
  installPreloadErrorHandler(browserEnvironment());
};
