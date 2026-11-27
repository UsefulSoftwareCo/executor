import { Schema } from "effect";
import { LocalConfigurationReason } from "@executor-js/local-server/auth";
import { ServiceFailed, ServiceSettingInvalid } from "../../../server/src/contracts/service.ts";

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

export class DesktopFailed extends Schema.TaggedError<DesktopFailed>()("DesktopFailed", {
  stage: Schema.Literals(["configuration", "runtime", "pairing", "window", "renderer", "oauth"]),
}) {}

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
  | { readonly stage: "dashboard"; readonly detail: string }
  | { readonly stage: "stopped" };

export const RecoveryAction = Schema.Literals(["start", "restart", "logs", "reset", "quit"]);
export type RecoveryAction = typeof RecoveryAction.Type;

export const BackupManifest = Schema.Struct({
  version: Schema.Literal(1),
  appVersion: Schema.String,
  createdAt: Schema.String,
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

export class ResetFailed extends Schema.TaggedError<ResetFailed>()("ResetFailed", {
  stage: Schema.Literals(["stop", "lock", "move"]),
}) {}

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

export class UpdateFailed extends Schema.TaggedError<UpdateFailed>()("UpdateFailed", {}) {}

export class BrowserOpenFailed extends Schema.TaggedError<BrowserOpenFailed>()(
  "BrowserOpenFailed",
  {},
) {}

export const DesktopPort = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1024, maximum: 65535 }),
);

export const LegacyDesktopSettings = Schema.Struct({
  version: Schema.Literal(1),
  port: DesktopPort,
});

export class SettingsFailed extends Schema.TaggedError<SettingsFailed>()("SettingsFailed", {}) {}

export class DiagnosticsFailed extends Schema.TaggedError<DiagnosticsFailed>()(
  "DiagnosticsFailed",
  {},
) {}

export const DesktopRuntimeBuild = Schema.Struct({
  version: Schema.String,
  build: Schema.String.check(Schema.isPattern(/^[a-f0-9]{12}$/u)),
});
export type DesktopRuntimeBuild = typeof DesktopRuntimeBuild.Type;
export const desktopRuntimeBuildFile = "desktop-runtime.json";

export class StarterDirectoryFailed extends Schema.TaggedError<StarterDirectoryFailed>()(
  "StarterDirectoryFailed",
  {},
) {}

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

export const StarterAttempt = Schema.TaggedUnion({
  AttemptStarted: { pid: Schema.Number },
  AttemptExited: { pid: Schema.Number },
});
export type StarterAttempt = typeof StarterAttempt.Type;
