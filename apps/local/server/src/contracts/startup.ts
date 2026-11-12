/** Startup failures are safe to display; transport payloads and keys stay out of diagnostics. */
import { Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { serverFlag, standaloneFlag } from "./service.ts";

/** System codes permitted in persistent startup diagnostics. */
export const StartupCode = Schema.Literals([
  "EADDRINUSE",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EISDIR",
  "EEXIST",
  "EMFILE",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);

/** One explicit startup stage failed without exposing its raw input. */
export class StartupFailed extends Schema.TaggedError<StartupFailed>()("StartupFailed", {
  stage: Schema.Literals([
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
}) {
  get message() {
    return `Local startup failed at ${this.stage}${this.code === undefined ? "" : ` (${this.code})`}`;
  }
}
/**
 * CLI declarations parse before handlers acquire configuration or server resources. The default
 * command uses the background server unless `--standalone` or `--server` chooses another.
 */
export const executorCommand = Command.make("executor", {
  standalone: standaloneFlag,
  server: serverFlag,
}).pipe(Command.withDescription("Start or join the background Executor and open its dashboard"));

/**
 * Run a server in this process without opening a browser. `--service` is the background server a
 * client starts; `--stdio` is a client's private server, which prints `{"url"}` and stops when its
 * stdin closes.
 */
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

/** The desktop app pairs its own server; the CLI may not know its data directory or port. */
export const desktopPairing =
  "If Executor desktop is running, use its File > Open in browser menu item instead.";

/**
 * Pairing found no running server, a registered one still starting, stopping or not responding
 * after 30 seconds, a server that refused the credential, or something that is not a working
 * Executor server, including one whose link the CLI may not open. Pairing only reads keys, so
 * every message says what to correct and that nothing was changed. `keys` says which credential
 * was sent: the API key saved in `directory`, EXECUTOR_API_KEY, or the password the background
 * server registered. `server` is the host the request went to; none when no server was found.
 */
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

/**
 * Install a newer release the way this copy was installed: a standalone install downloads and
 * switches to it, and an npm-family install runs its package manager.
 */
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

/**
 * `executor upgrade` stopped. Every message says what to do next, and whether anything changed:
 * only `install-failed` and `verify-failed` follow a package manager run, and a standalone
 * install switches versions only after the new one has passed its checks. `service-running`: the
 * background server did not stop, so the package manager did not run over its files. A failure
 * after the background server stopped starts it again first.
 */
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
