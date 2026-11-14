/**
 * Diagnostics export: one zip in Downloads that a user can attach to a report.
 *
 * Only allowlisted log files from the data directory's `diagnostics/` are read. Keys, the
 * installation record, databases, retained builds, the browser profile and the telemetry collector's
 * store are
 * never opened. Logs already carry redacted values; the export also masks credential shapes
 * (bearer values, pairing and signed-link tokens, 64-character hex keys and credential-named
 * JSON fields) as a second barrier before anything leaves the machine.
 */
import { app, dialog, shell } from "electron";
import { strToU8, zipSync } from "fflate";
import { Clock, DateTime, Effect, FileSystem, Option, Path, Semaphore } from "effect";
import { DiagnosticsFailed } from "../contracts/desktop.ts";
import type { PortSource } from "./settings.ts";

const maxFileBytes = 50 * 1024 * 1024;
const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
/** Rotating JSONL logs (current file and archives) and the collector status file. */
const exported = /^(?:executor-[a-z]+\.jsonl(?:\.[1-4])?|collector\.json)$/;

const credentialName = String.raw`[^"\\]*(?:token|secret|password|authorization|cookie|api[-_]?key)[^"\\]*`;
/** A credential-named JSON string field, and the same field inside an embedded JSON log line. */
const credentialField = new RegExp(String.raw`("${credentialName}"\s*:\s*)"(?:[^"\\]|\\.)*"`, "gi");
const embeddedCredentialField = new RegExp(
  String.raw`(\\"${credentialName}\\"\s*:\s*)\\"[^"\\]*\\"`,
  "gi",
);

/** Mask credential shapes in exported text. Trace and span IDs are shorter than 64 hex digits. */
export const redact = (text: string) =>
  text
    .replace(credentialField, '$1"[redacted]"')
    .replace(embeddedCredentialField, '$1\\"[redacted]\\"')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/([#?&](?:pair|token|code|state)=)[^&#\s"\\]+/gi, "$1[redacted]")
    .replace(/[0-9a-fA-F]{64,}/g, "[redacted]");

const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** Make the "Export diagnostics…" action. Failures show a native dialog without file contents. */
export const makeExportDiagnosticsAction = (options: {
  readonly directory: string;
  /** The background server's origin, if the window is connected to one. */
  readonly origin: () => string | undefined;
  readonly portSource: Effect.Effect<PortSource>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = yield* Semaphore.make(1);
    const logs = path.join(options.directory, "diagnostics");
    const collect = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const names = (yield* fs.exists(logs)) ? yield* fs.readDirectory(logs) : [];
      const files: Record<string, Uint8Array> = {};
      const included: Array<string> = [];
      for (const name of names.filter((name) => exported.test(name)).sort()) {
        const file = path.join(logs, name);
        const info = yield* fs.stat(file);
        if (info.type !== "File" || Number(info.size) > maxFileBytes) continue;
        const modified = Option.getOrUndefined(info.mtime);
        if (modified !== undefined && now - modified.getTime() > maxAgeMs) continue;
        files[`diagnostics/${name}`] = strToU8(redact(yield* fs.readFileString(file)));
        included.push(`diagnostics/${name}`);
      }
      const generated = DateTime.formatIso(DateTime.makeUnsafe(now));
      const manifest = {
        generated,
        app: app.getName(),
        version: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        versions: {
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
        },
        uptimeSeconds: Math.round(process.uptime()),
        server: { origin: options.origin() ?? null, portSource: (yield* options.portSource).kind },
        dataDirectory: options.directory,
        files: included,
        // Keys stay in the OS credential store or keys.json; they are never part of an export.
        excluded: [
          "keys and installation record",
          "databases and retained builds",
          "browser profile",
          "telemetry collector storage",
        ],
      };
      files["manifest.json"] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
      const output = path.join(
        app.getPath("downloads"),
        `executor-diagnostics-${stamp(generated)}.zip`,
      );
      yield* fs.writeFile(output, zipSync(files), { mode: 0o600 });
      yield* Effect.logInfo("Exported diagnostics").pipe(
        Effect.annotateLogs({ files: included.length }),
      );
      shell.showItemInFolder(output);
    }).pipe(
      Effect.mapError(() => new DiagnosticsFailed()),
      Effect.catch(() =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Could not export diagnostics");
          yield* Effect.tryPromise({
            try: () =>
              dialog.showMessageBox({
                type: "error",
                message: "Executor could not export diagnostics.",
                detail: `Check that your Downloads folder is writable. Logs remain in ${logs}.`,
              }),
            catch: () => new DiagnosticsFailed(),
          }).pipe(Effect.ignore);
        }),
      ),
    );
    return lock.withPermitsIfAvailable(1)(collect);
  });
