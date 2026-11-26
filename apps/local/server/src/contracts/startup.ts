import { Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { serverFlag, standaloneFlag } from "./service.ts";

export const StartupCode = Schema.Literals([
  "EADDRINUSE",
  "EACCES",
  "EPERM",
  "EBUSY",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EISDIR",
  "EEXIST",
  "EMFILE",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);

export const LocalDatabaseName = Schema.Literals([
  "browser-auth.pglite",
  "executor.pglite",
  "mcp-auth.pglite",
]);

const creationSteps = {
  clear: "remove the unfinished copy left beside",
  create: "create a new copy beside",
  "set aside": "move aside the unrecognised contents of",
  "move into place": "move the new copy into place as",
} as const;

export class StartupFailed extends Schema.TaggedError<StartupFailed>()("StartupFailed", {
  stage: Schema.Literals([
    "database",
    "authentication",
    "storage",
    "runtime",
    "sdk",
    "data-steps",
    "composition",
    "listen",
    "browser",
    "dev-server",
  ]),
  code: Schema.optional(StartupCode),
  database: Schema.optional(LocalDatabaseName),
  step: Schema.optional(Schema.Literals(["clear", "create", "set aside", "move into place"])),
  buildFailure: Schema.optional(Schema.String),
}) {
  get message() {
    const code = this.code === undefined ? "" : ` (${this.code})`;
    const detail = this.buildFailure === undefined ? "" : `: ${this.buildFailure}`;
    return this.stage === "database" && this.step !== undefined
      ? `Local startup could not ${creationSteps[this.step]} the database ${this.database ?? "it opens"}${code}`
      : `Local startup failed at ${this.stage}${code}${detail}`;
  }
}
export const executorCommand = Command.make("executor", {
  standalone: standaloneFlag,
  server: serverFlag,
}).pipe(Command.withDescription("Start or join the background Executor and open its dashboard"));

export const serveCommand = Command.make("serve", {
  service: Flag.Boolean("service").pipe(
    Flag.withDescription("Run as the background server for this data directory"),
    Flag.withDefault(false),
    Flag.withHidden,
  ),
  stdio: Flag.Boolean("stdio").pipe(
    Flag.withDescription("Run as a private server until standard input closes"),
    Flag.withDefault(false),
    Flag.withHidden,
  ),
}).pipe(Command.withDescription("Start without opening a browser"));

export const desktopPairing =
  "If Executor desktop is running, use its File > Open in browser menu item instead.";

export class PairFailed extends Schema.TaggedError<PairFailed>()("PairFailed", {
  reason: Schema.Literals([
    "no-server",
    "starting",
    "stopping",
    "unresponsive",
    "key-rejected",
    "storage-unavailable",
    "unexpected-response",
  ]),
  server: Schema.optional(Schema.String),
  directory: Schema.String,
  keys: Schema.Literals(["saved", "supplied", "registered"]),
}) {
  get message() {
    const server = this.server ?? "the registered address";
    switch (this.reason) {
      case "no-server":
        return `No background Executor is running for ${this.directory}. Start it with \`executor\` or \`executor service start\`. ${desktopPairing} Nothing was changed.`;
      case "starting":
        return `The background Executor on ${server} is still starting. Try again shortly, or run \`executor service status\` to check it. Nothing was changed.`;
      case "stopping":
        return `The background Executor on ${server} is still stopping. Run \`executor service restart\` to stop it and start it again. Nothing was changed.`;
      case "unresponsive":
        return `The background Executor on ${server} is not responding. Run \`executor service restart\` to stop it and start it again. Nothing was changed.`;
      case "key-rejected":
        return {
          supplied: `The Executor server on ${server} did not accept the supplied EXECUTOR_API_KEY. Supply the key that server started with. Nothing was changed.`,
          saved: `The Executor server on ${server} did not accept the API key saved in ${this.directory}. It may use another data directory: set EXECUTOR_DATA_DIR to the folder it uses. ${desktopPairing} If you ran \`executor service rotate-key\`, restart the server to use the new key. Nothing was changed.`,
          registered: `The background Executor on ${server} did not accept the password it registered in ${this.directory}. Run \`executor service restart\`, then try again. Nothing was changed.`,
        }[this.keys];
      case "storage-unavailable":
        return `The Executor server on ${server} could not save a connection link because its access storage is unavailable. Try again, and restart the server if this continues. Nothing was changed.`;
      case "unexpected-response":
        return `Something is listening on ${server}, but it did not answer as an Executor server. Run \`executor service status\` to see where the background Executor listens. Nothing was changed.`;
    }
  }
}

export const upgradeCommand = Command.make("upgrade", {
  version: Argument.String("version").pipe(
    Argument.withDescription("Release to install, such as 2.0.0-beta.16. Default: the newest"),
    Argument.optional,
  ),
  method: Flag.Literals("method", ["npm", "pnpm", "bun", "yarn"]).pipe(
    Flag.withDescription("Package manager to install with, instead of the detected one"),
    Flag.optional,
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription("Do not ask for confirmation; required to downgrade without a terminal"),
    Flag.withDefault(false),
  ),
  rollback: Flag.Boolean("rollback").pipe(
    Flag.withDescription(
      "Switch a standalone install back to the version it ran before its last upgrade",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Install the newest Executor release on this installation's channel, or the given version. A standalone install keeps the previous version for --rollback",
  ),
);

export class UpgradeFailed extends Schema.TaggedError<UpgradeFailed>()("UpgradeFailed", {
  reason: Schema.Literals([
    "development-build",
    "invalid-version",
    "registry-unavailable",
    "unknown-release",
    "node-too-old",
    "unknown-install",
    "downgrade-unconfirmed",
    "cancelled",
    "install-failed",
    "verify-failed",
    "download-failed",
    "checksum-mismatch",
    "no-previous-version",
    "not-standalone",
    "service-running",
  ]),
  message: Schema.String,
}) {}
