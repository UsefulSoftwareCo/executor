/**
 * In-window screen shown when the sidecar dies under a running window.
 * Replaces the dead web UI (which would otherwise sit there failing every
 * fetch) with an explanation and a recovery path. Rendered as a data: URL
 * in the existing BrowserWindow, so the preload bridge stays available —
 * the buttons drive the same `window.executor` IPC the settings page uses.
 */

export interface CrashScreenOptions {
  /** Whether a crash report was sent upstream (DSN build, not opted out). */
  readonly reported: boolean;
}

export const sidecarCrashHtml = ({ reported }: CrashScreenOptions): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Executor</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0a0a0a;
        color: #fafafa;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .card { max-width: 26rem; padding: 2rem; text-align: center; }
      .icon { font-size: 2rem; margin-bottom: 0.75rem; }
      h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 0.5rem; }
      p { font-size: 0.875rem; color: #a1a1aa; line-height: 1.5; margin: 0 0 1.5rem; }
      .row { display: flex; gap: 0.6rem; justify-content: center; }
      button {
        padding: 0.55rem 1.1rem;
        border-radius: 6px;
        border: 1px solid transparent;
        background: #fafafa;
        color: #0a0a0a;
        font: inherit;
        font-size: 0.875rem;
        cursor: pointer;
        white-space: nowrap;
      }
      button.secondary { background: transparent; color: #fafafa; border-color: #3f3f46; }
      #status { margin-top: 1.25rem; min-height: 1.2em; font-size: 0.8rem; color: #a1a1aa; }
      .reset-row { margin-top: 1.75rem; font-size: 0.75rem; color: #71717a; }
      .reset-row a { color: #f87171; text-decoration: underline; cursor: pointer; }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="icon">&#9888;&#65039;</div>
      <h1>The local Executor server stopped unexpectedly</h1>
      <p>
        Your data is safe.${reported ? " A crash report was sent automatically so this can get fixed." : ""}
        Restart the server to keep working.
      </p>
      <div class="row">
        <button id="restart">Restart server</button>
        <button id="update" class="secondary">Check for updates</button>
        <button id="export" class="secondary">Export diagnostics</button>
      </div>
      <p id="status"></p>
      <p class="reset-row">
        Still won't start after restarting?
        <a id="reset" href="#">Reset data</a>
        clears a damaged database to get the app running again.
      </p>
    </main>
    <script>
      const status = document.getElementById("status");
      document.getElementById("restart").addEventListener("click", async () => {
        status.textContent = "Restarting\\u2026";
        try {
          // Main restarts the sidecar and reloads this window on success.
          await window.executor.restartServer();
        } catch {
          status.textContent = "Restart failed \\u2014 try quitting and reopening Executor.";
        }
      });
      document.getElementById("update").addEventListener("click", async () => {
        status.textContent = "Checking for updates\\u2026";
        try {
          // Outcomes surface as native dialogs (install prompt / no updates).
          await window.executor.checkForUpdates();
          status.textContent = "";
        } catch {
          status.textContent = "Update check failed \\u2014 check your network.";
        }
      });
      document.getElementById("export").addEventListener("click", async () => {
        status.textContent = "Exporting\\u2026";
        try {
          await window.executor.exportDiagnostics();
          status.textContent = "Diagnostics saved to Downloads.";
        } catch {
          status.textContent = "Export failed \\u2014 see the log file.";
        }
      });
      document.getElementById("reset").addEventListener("click", async (event) => {
        event.preventDefault();
        try {
          // Native confirm runs in main; on accept, state is backed up and
          // the server restarts (window reloads on success). false = cancel.
          const didReset = await window.executor.resetState();
          if (!didReset) return;
          status.textContent = "";
        } catch {
          status.textContent = "Reset failed \\u2014 see the log file.";
        }
      });
    </script>
  </body>
</html>`;
