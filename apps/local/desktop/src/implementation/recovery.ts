/**
 * Isolated, script-free recovery document shown when the background server cannot run. Its buttons are
 * links to `executor-recovery:<action>`, which the main process intercepts in `will-navigate`;
 * the window keeps no preload or IPC bridge.
 */
import { Option, Schema } from "effect";
import { RecoveryAction, type DesktopRecovery } from "../contracts/desktop.ts";

const scheme = "executor-recovery:";

interface Page {
  readonly title: string;
  readonly detail: string;
  readonly actions: ReadonlyArray<RecoveryAction>;
}

/**
 * Reset is offered only when moving the data aside can help. Never for an unavailable or denied
 * store, or for key settings the user must change: the data may be intact.
 */
const page = (recovery: DesktopRecovery): Page => {
  switch (recovery.stage) {
    case "start":
      return {
        title: "Executor could not start its local server",
        detail:
          "Restart to try again. If another program uses Executor's port, choose another with File → Server port… first. If Executor's data is damaged, reset it. Reset keeps a backup.",
        actions: ["restart", "logs", "reset", "quit"],
      };
    case "runtime":
      return {
        title: "Executor could not prepare its local server",
        detail:
          "Its server program could not be copied out of the app. Check free disk space, then restart. If this continues, reinstall Executor.",
        actions: ["restart", "logs", "quit"],
      };
    case "crash-loop":
      return {
        title: "Executor keeps stopping",
        detail:
          "Its local server stopped unexpectedly three times within a minute. Restart to try again, or reset Executor's data if it is damaged. Reset keeps a backup.",
        actions: ["restart", "logs", "reset", "quit"],
      };
    case "stopped":
      return {
        title: "The background Executor was stopped",
        detail:
          "It was stopped on purpose, for example by executor service stop in a terminal, so Executor does not start it again by itself. It reconnects as soon as the background Executor runs again, or you can start it now.",
        actions: ["start", "quit"],
      };
    case "dashboard":
      return {
        title: "Executor could not load its dashboard",
        detail:
          "Its local server is running, but this window could not load the dashboard from it. Restart to try again. Your data has not been changed.",
        actions: ["restart", "logs", "quit"],
      };
    case "migration":
      return {
        title: "Executor could not move its data",
        detail:
          "Executor now keeps its data with the Executor CLI's, and moving it there failed. Nothing was deleted. Fix what the message below describes, then restart.",
        actions: ["restart", "quit"],
      };
    case "configuration":
      switch (recovery.reason) {
        case "credential-unavailable":
          return {
            title: "Executor cannot open the OS credential store",
            detail:
              "This data keeps its keys in the OS credential store, which could not be found. On Linux, start a Secret Service such as GNOME Keyring, then restart. Your data has not been changed.",
            actions: ["restart", "logs", "quit"],
          };
        case "credential-denied":
          return {
            title: "Executor needs access to your keychain",
            detail:
              "Access was denied or the keychain is locked. Restart to be asked again, then choose Allow. Your data has not been changed.",
            actions: ["restart", "logs", "quit"],
          };
        case "credential-missing":
          return {
            title: "Executor's saved key is missing",
            detail:
              "The key for this data is not available. Restore it from your backup and restart, or reset to start over. Reset keeps a backup of the current data.",
            actions: ["restart", "logs", "reset", "quit"],
          };
        case "invalid":
          return {
            title: "Executor's saved key setup is damaged",
            detail:
              "The installation record or saved keys for this data are invalid. Restore them from your backup and restart, or reset to start over. Reset keeps a backup of the current data.",
            actions: ["restart", "logs", "reset", "quit"],
          };
        case "misconfigured":
          return {
            title: "Executor's key settings do not match its data",
            detail:
              "EXECUTOR_KEY_STORAGE, EXECUTOR_API_KEY or EXECUTOR_ENCRYPTION_KEY is set in a way this data cannot use. Change or unset it, then restart. Your data has not been changed.",
            actions: ["restart", "logs", "quit"],
          };
        case "locked":
          return {
            title: "Executor's data is in use",
            detail:
              "Another Executor process that is not its background server is using this data directory. Quit it, then restart.",
            actions: ["restart", "logs", "quit"],
          };
        case "io":
          return {
            title: "Executor cannot read its data",
            detail:
              "Check the data directory's permissions and free disk space, then restart. Existing keys have not been replaced.",
            actions: ["restart", "logs", "quit"],
          };
      }
  }
};

const labels: Record<RecoveryAction, string> = {
  start: "Start",
  restart: "Restart",
  logs: "Show logs",
  reset: "Reset data…",
  quit: "Quit",
};

export const recoveryActions = (recovery: DesktopRecovery) => page(recovery).actions;

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );

/** What the server or the migration said, at most this many characters from its end. */
const messageLimit = 2000;

export const recoveryUrl = (recovery: DesktopRecovery) => {
  const { title, detail, actions } = page(recovery);
  const said = "detail" in recovery ? recovery.detail.trim().slice(-messageLimit) : "";
  const message = said === "" ? "" : `<pre>${escape(said)}</pre>`;
  const buttons = actions
    .map(
      (action, index) =>
        `<a role="button" class="${index === 0 ? "primary" : ""}" href="${scheme}${action}">${labels[action]}</a>`,
    )
    .join("");
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Executor</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { max-width: 440px; text-align: center; padding: 32px; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.5px; margin: 0 0 10px; }
  p { font-size: 14px; line-height: 1.5; margin: 0 0 24px; opacity: 0.65; }
  pre { font-size: 12px; line-height: 1.45; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere;
        max-height: 180px; overflow: auto; margin: -8px 0 24px; padding: 10px 12px; border-radius: 6px;
        background: color-mix(in srgb, CanvasText 6%, transparent); }
  nav { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
  a { font-size: 13px; font-weight: 500; padding: 7px 14px; border-radius: 6px; text-decoration: none;
      color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
  a:hover { background: color-mix(in srgb, CanvasText 8%, transparent); }
  a.primary { background: CanvasText; color: Canvas; border-color: CanvasText; }
  a.primary:hover { opacity: 0.85; }
</style>
<main role="alert"><h1>${title}</h1><p>${detail}</p>${message}<nav>${buttons}</nav></main>
</html>`)}`;
};

/** `Some(action)` for a well-formed recovery link, `None` for any other URL. */
export const recoveryAction = (url: string): Option.Option<RecoveryAction> =>
  url.startsWith(scheme)
    ? Schema.decodeUnknownOption(RecoveryAction)(url.slice(scheme.length))
    : Option.none();

/** Links using the recovery scheme never leave the app, even when malformed. */
export const isRecoveryLink = (url: string) => url.startsWith(scheme);
