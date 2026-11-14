import { Schema } from "effect";
import { LocalConfigurationReason } from "@executor-js/local-server/auth";
import { ServiceFailed, ServiceSettingInvalid } from "../../../server/src/contracts/service.ts";

/** Only the background server's exact loopback HTTP origin can host the dashboard. */
export const LocalOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.port !== "" &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }),
);

/** Safe desktop failures never include process output, passwords or callback URLs. */
export class DesktopFailed extends Schema.TaggedError<DesktopFailed>()("DesktopFailed", {
  stage: Schema.Literals(["configuration", "runtime", "pairing", "window", "renderer", "oauth"]),
}) {}

/**
 * Why the window shows the recovery screen instead of the dashboard. `detail` is what the
 * background server or the data migration said, shown under the explanation.
 */
export type DesktopRecovery =
  | { readonly stage: "start"; readonly detail: string }
  | {
      readonly stage: "configuration";
      readonly reason: LocalConfigurationReason;
      readonly detail: string;
    }
  | { readonly stage: "runtime" }
  | { readonly stage: "crash-loop" }
  | { readonly stage: "migration"; readonly detail: string }
  /** The background server runs, but the window could not load its dashboard. */
  | { readonly stage: "dashboard"; readonly detail: string }
  /** The background server was stopped on purpose, and none runs yet. */
  | { readonly stage: "stopped" };

/** Buttons on the script-free recovery page navigate to `executor-recovery:<action>`. */
export const RecoveryAction = Schema.Literals(["start", "restart", "logs", "reset", "quit"]);
export type RecoveryAction = typeof RecoveryAction.Type;

/**
 * `executor-backup.json` inside a reset backup. It identifies the OS credential entry that still
 * holds the backup's keys, or says they are in the backup's own `keys.json`; it never contains a key.
 */
export const BackupManifest = Schema.Struct({
  version: Schema.Literal(1),
  appVersion: Schema.String,
  createdAt: Schema.String,
  /** The data directory this backup was moved from. */
  source: Schema.String,
  installation: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      keySource: Schema.Literals(["os-credential-store", "key-file", "environment"]),
      credential: Schema.optionalKey(
        Schema.Struct({ service: Schema.String, account: Schema.String }),
      ),
    }),
  ),
});

/** Reset refuses before moving anything, or after leaving the data in place. */
export class ResetFailed extends Schema.TaggedError<ResetFailed>()("ResetFailed", {
  stage: Schema.Literals(["stop", "lock", "move"]),
}) {}

/** Accept ordinary web links; operating-system and executable schemes are not supported. */
export const externalUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

/** Update-provider failures never expose raw release-feed responses. */
export class UpdateFailed extends Schema.TaggedError<UpdateFailed>()("UpdateFailed", {}) {}

/** Browser launch failures never expose pairing links, session cookies or server responses. */
export class BrowserOpenFailed extends Schema.TaggedError<BrowserOpenFailed>()(
  "BrowserOpenFailed",
  {},
) {}

/** A listener port a user may choose. Privileged ports and port 0 are reserved for other callers. */
export const DesktopPort = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1024, maximum: 65535 }),
);

/**
 * `desktop.json` in the data directory desktops before the background service used. Only the
 * one-off migration reads it, to carry its port over to the background service's settings.
 */
export const LegacyDesktopSettings = Schema.Struct({
  version: Schema.Literal(1),
  port: DesktopPort,
});

/** Saving a setting failed. It never exposes the file contents. */
export class SettingsFailed extends Schema.TaggedError<SettingsFailed>()("SettingsFailed", {}) {}

/** Diagnostics export failures never include the files being collected. */
export class DiagnosticsFailed extends Schema.TaggedError<DiagnosticsFailed>()(
  "DiagnosticsFailed",
  {},
) {}

/**
 * `desktop-runtime.json` beside the server runtime a desktop build bundles. Each build has its own
 * `build`, so a rebuilt runtime is staged again even when the version did not change.
 */
export const DesktopRuntimeBuild = Schema.Struct({
  version: Schema.String,
  build: Schema.String.check(Schema.isPattern(/^[a-f0-9]{12}$/u)),
});
export type DesktopRuntimeBuild = typeof DesktopRuntimeBuild.Type;
/** The file name of `DesktopRuntimeBuild` in a bundled or staged runtime. */
export const desktopRuntimeBuildFile = "desktop-runtime.json";

/** The server starter could not create or read the data directory. */
export class StarterDirectoryFailed extends Schema.TaggedError<StarterDirectoryFailed>()(
  "StarterDirectoryFailed",
  {},
) {}

/**
 * What the desktop sends its server starter, an Electron utility process, over that process's
 * parent port. `Start` starts or joins the background server for `directory` with `program`, as
 * the CLI's `ensure` does; `version` decides whether a server of another version is replaced. It
 * is never passed on the command line, since `program.env` may hold keys. `Stop` ends the starter:
 * one still starting first asks the start attempts it began to exit, as an interrupted `ensure`
 * does.
 */
export const StarterCommand = Schema.TaggedUnion({
  Start: {
    directory: Schema.String,
    version: Schema.Literals(["replace", "ignore"]),
    program: Schema.Struct({
      command: Schema.Array(Schema.String),
      version: Schema.String,
      env: Schema.Record(Schema.String, Schema.String),
    }),
  },
  Stop: {},
});
export type StarterCommand = typeof StarterCommand.Type;

/**
 * What the server starter reports: `Starting` when it starts a server, replacing one of version
 * `previous` if given, then one outcome. `Ready` is the server that answered as the registered
 * one; its password works as the local API key. `Failed` says why no server started or answered.
 */
export const StarterReport = Schema.TaggedUnion({
  Starting: { version: Schema.String, previous: Schema.optionalKey(Schema.String) },
  Ready: {
    url: Schema.String,
    version: Schema.String,
    pid: Schema.Number,
    password: Schema.RedactedFromValue(Schema.String),
    browserOrigin: Schema.optional(Schema.String),
  },
  Failed: { error: Schema.Union([ServiceFailed, ServiceSettingInvalid, StarterDirectoryFailed]) },
});
export type StarterReport = typeof StarterReport.Type;

/**
 * Besides its report, the server starter says when it begins a start attempt, with the attempt's
 * process ID, and when that attempt has exited. The desktop ends the attempts still running if it
 * has to kill the starter, which then never asks them to exit (see `ensureServer`).
 */
export const StarterAttempt = Schema.TaggedUnion({
  AttemptStarted: { pid: Schema.Number },
  AttemptExited: { pid: Schema.Number },
});
export type StarterAttempt = typeof StarterAttempt.Type;
