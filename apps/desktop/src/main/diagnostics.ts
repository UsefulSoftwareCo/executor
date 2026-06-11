/**
 * Crash reporting + diagnostics export for the Electron main process.
 *
 * Error reporting is Sentry-backed and gated entirely on a DSN being baked
 * in at build time (publish-desktop.yml exports SENTRY_DSN; see the define
 * in electron.vite.config.ts). Local/dev builds have no DSN, so nothing is
 * ever sent — instead Electron's native crash reporter still writes
 * minidumps locally so they ride along in the diagnostics zip.
 *
 * What reaches Sentry when enabled:
 *   - main-process uncaught exceptions / unhandled rejections
 *   - native minidumps (main, renderer, GPU) via the Crashpad integration
 *   - renderer/child process terminations (render-process-gone et al.)
 *   - sidecar crashes after a successful boot, with a stderr tail
 *
 * What never leaves the machine: executor data (~/.executor — data.db holds
 * user secrets) and the desktop settings password. The diagnostics zip only
 * packs log files, crash dumps, and a redacted manifest.
 */

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, crashReporter, dialog, shell } from "electron";
import log from "electron-log/main.js";
import * as Sentry from "@sentry/electron/main";
import { getServerSettings } from "./settings";

const sentryDsn = __EXECUTOR_SENTRY_DSN__;

export const errorReportingEnabled = sentryDsn.length > 0;

/**
 * Must run before `app.whenReady()` so the Crashpad handler attaches to
 * every child process Electron spawns.
 */
export const initErrorReporting = () => {
  if (errorReportingEnabled) {
    Sentry.init({
      dsn: sentryDsn,
      release: `executor-desktop@${app.getVersion()}`,
      environment: app.isPackaged ? "production" : "development",
      initialScope: {
        tags: {
          platform: process.platform,
          arch: process.arch,
        },
      },
    });
  } else {
    // No DSN baked in — keep native crash dumps local so a user-reported
    // crash still leaves minidumps for the diagnostics zip to collect.
    crashReporter.start({ uploadToServer: false, compress: true });
  }

  // Persist process-death signals to main.log regardless of Sentry — these
  // are the events a "the app just disappeared" report hinges on. Sentry's
  // ChildProcess integration reports them upstream; this keeps a local copy.
  app.on("child-process-gone", (_event, details) => {
    log.error("[crash] child process gone", details);
  });
  app.on("render-process-gone", (_event, webContents, details) => {
    log.error("[crash] render process gone", { url: webContents.getURL(), ...details });
  });

  // Main-process uncaught errors: electron-log writes them to main.log and
  // keeps the process alive (matching its default), Sentry (when enabled)
  // captures them via its own integrations.
  log.errorHandler.startCatching({ showDialog: false });
};

/**
 * Report a sidecar crash that happened after a successful boot. The startup
 * path already surfaces its own dialog; this covers the "server died under
 * a running window" case, which is otherwise invisible.
 */
export const reportSidecarCrash = (message: string, stderrTail: string) => {
  // No-op when Sentry isn't initialized — captures are dropped client-side.
  Sentry.captureMessage(message, {
    level: "error",
    extra: { stderrTail },
  });
};

// ---------------------------------------------------------------------------
// Diagnostics export — one zip in ~/Downloads a user can attach to a report.
// ---------------------------------------------------------------------------

const MAX_EXPORT_FILE_BYTES = 50 * 1024 * 1024;
const EXPORT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface ZipEntry {
  readonly name: string;
  readonly path: string;
}

/** Recursively list files under `dir`, capped by size and age. */
const collectFiles = (dir: string, prefix: string): ZipEntry[] => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fs probing of optional directories (crash dumps may not exist)
  try {
    const cutoff = Date.now() - EXPORT_MAX_AGE_MS;
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return collectFiles(full, `${prefix}/${entry.name}`);
      if (!entry.isFile()) return [];
      const info = statSync(full);
      if (info.size > MAX_EXPORT_FILE_BYTES) return [];
      if (info.mtimeMs < cutoff) return [];
      return [{ name: `${prefix}/${entry.name}`, path: full }];
    });
  } catch {
    return [];
  }
};

const exportStamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

const buildManifest = () => {
  const settings = getServerSettings();
  return {
    generated: new Date().toISOString(),
    app: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    uptimeSeconds: Math.round(process.uptime()),
    errorReportingEnabled,
    paths: {
      userData: app.getPath("userData"),
      logs: dirname(log.transports.file.getFile().path),
      crashDumps: app.getPath("crashDumps"),
    },
    // Redacted on purpose: the Basic-auth password never leaves the machine.
    serverSettings: {
      port: settings.port,
      requireAuth: settings.requireAuth,
    },
  };
};

/**
 * Pack manifest + electron-log files + sidecar log + crash dumps into
 * `~/Downloads/executor-diagnostics-<stamp>.zip` and reveal it in the file
 * manager. Returns the zip path.
 */
export const exportDiagnostics = async (): Promise<string> => {
  const { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } =
    await import("@zip.js/zip.js");
  const { readFile } = await import("node:fs/promises");

  const logsDir = dirname(log.transports.file.getFile().path);
  const entries: ZipEntry[] = [
    ...collectFiles(logsDir, "logs"),
    ...collectFiles(app.getPath("crashDumps"), "crash-dumps"),
  ];

  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("manifest.json", new TextReader(JSON.stringify(buildManifest(), null, 2)));
  for (const entry of entries) {
    await writer.add(entry.name, new Uint8ArrayReader(new Uint8Array(await readFile(entry.path))));
  }
  const zipped = await writer.close();

  const output = join(app.getPath("downloads"), `executor-diagnostics-${exportStamp()}.zip`);
  writeFileSync(output, zipped);
  log.info("[diagnostics] exported", { output, files: entries.length });
  shell.showItemInFolder(output);
  return output;
};

/** Menu-item wrapper: surface failures in a dialog instead of dying silently. */
export const exportDiagnosticsInteractive = async () => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: user-initiated export surfaces failures in a native dialog
  try {
    await exportDiagnostics();
  } catch (error) {
    log.error("[diagnostics] export failed", error);
    // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: fs/zip failures arrive as plain Node errors and render in a native dialog
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await dialog.showMessageBox({
      type: "error",
      title: "Diagnostics export failed",
      message: "Couldn't write the diagnostics zip.",
      detail: `${detail.slice(0, 1200)}\n\nLogs live at: ${dirname(log.transports.file.getFile().path)}`,
    });
  }
};
