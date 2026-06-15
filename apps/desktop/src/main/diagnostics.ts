/**
 * Crash reporting + diagnostics export for the Electron main process.
 *
 * Error reporting is Sentry-backed and gated entirely on a DSN being baked
 * in at build time (publish-desktop.yml exports DESKTOP_SENTRY_DSN; see the define
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

// The informal cross-tool opt-out (consoledonottrack.com). Checked before
// any SDK initializes, and it covers all three processes because the
// renderer and sidecar both receive their config from this module.
const doNotTrack =
  process.env.DO_NOT_TRACK === "1" || process.env.DO_NOT_TRACK?.toLowerCase() === "true";

export const errorReportingEnabled = sentryDsn.length > 0 && !doNotTrack;

/**
 * One id per app launch, shared by every process (main, renderer, sidecar)
 * and stamped into the diagnostics manifest — lets a user-sent zip be
 * matched to its Sentry events and vice versa.
 */
export const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

const releaseTag = () => `executor-desktop@${app.getVersion()}`;
const environmentTag = () => (app.isPackaged ? "production" : "development");

/**
 * Runtime crash-reporting config for the renderer (fetched over the preload
 * bridge). The web UI is the same bundle `executor web` serves, so nothing
 * is baked in at build time — outside the desktop app this returns null and
 * the renderer never initializes Sentry.
 */
export const getCrashReportingConfig = () =>
  errorReportingEnabled
    ? {
        dsn: sentryDsn,
        release: releaseTag(),
        environment: environmentTag(),
        runId,
      }
    : null;

/** Env vars handed to the sidecar so its process reports under the same id. */
export const sidecarCrashReportingEnv = (): Record<string, string> =>
  errorReportingEnabled
    ? {
        EXECUTOR_SENTRY_DSN: sentryDsn,
        EXECUTOR_SENTRY_RELEASE: releaseTag(),
        EXECUTOR_SENTRY_ENVIRONMENT: environmentTag(),
        EXECUTOR_RUN_ID: runId,
      }
    : {};

/**
 * Must run before `app.whenReady()` so the Crashpad handler attaches to
 * every child process Electron spawns.
 */
export const initErrorReporting = () => {
  if (errorReportingEnabled) {
    Sentry.init({
      dsn: sentryDsn,
      release: releaseTag(),
      environment: environmentTag(),
      initialScope: {
        tags: {
          platform: process.platform,
          arch: process.arch,
          runId,
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

  // Every log line becomes a Sentry breadcrumb, so an error event arrives
  // with the recent log context (sidecar restarts, update checks, …) instead
  // of a bare stack. Hooked on the file transport only so each line is
  // recorded once. No-ops when Sentry is disabled.
  log.hooks.push((message, transport) => {
    if (transport !== log.transports.file) return message;
    Sentry.addBreadcrumb({
      category: message.scope ?? "main",
      level: message.level === "warn" ? "warning" : message.level === "error" ? "error" : "info",
      message: message.data
        .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
        .join(" ")
        .slice(0, 1024),
    });
    return message;
  });
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
  const executorLogs = join(app.getPath("home"), ".executor", "logs");
  return {
    generated: new Date().toISOString(),
    app: app.getName(),
    runId,
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
      executorLogs,
      crashDumps: app.getPath("crashDumps"),
    },
    // The bearer token is never included — it stays in auth.json on the machine.
    serverSettings: {
      port: settings.port,
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
  const executorLogsDir = join(app.getPath("home"), ".executor", "logs");
  const entries: ZipEntry[] = [
    ...collectFiles(logsDir, "logs"),
    ...collectFiles(executorLogsDir, "executor-logs"),
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

/**
 * "Report a Problem…" menu flow: export the diagnostics zip, then open a
 * prefilled GitHub issue. The zip is revealed in the file manager so the
 * user can drag it onto the issue; nothing is uploaded automatically.
 */
export const reportAProblem = async () => {
  await exportDiagnosticsInteractive();
  const body = [
    "<!-- Describe what happened and what you expected. -->",
    "",
    "",
    "---",
    "",
    "| | |",
    "|---|---|",
    `| Version | ${app.getVersion()} |`,
    `| OS | ${process.platform} ${process.arch} |`,
    `| Run ID | ${runId} |`,
    "",
    "_A diagnostics zip was saved to your Downloads folder — please drag it into this issue._",
  ].join("\n");
  const url = new URL("https://github.com/RhysSullivan/executor/issues/new");
  url.searchParams.set("title", "[desktop] ");
  url.searchParams.set("body", body);
  await shell.openExternal(url.toString());
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
