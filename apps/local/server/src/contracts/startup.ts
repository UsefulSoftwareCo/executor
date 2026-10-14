/** Startup failures are safe to display; transport payloads and keys stay out of diagnostics. */
import { Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { hostedExecutorOrigin } from "@executor-js/sdk/core";

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
    "desktop-bootstrap",
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
/** Entry modes share a server implementation; desktop receives a private bootstrap pipe. */
export type LaunchMode = "browser" | "headless" | "desktop";

/** CLI declarations parse before handlers acquire configuration or server resources. */
export const executorCommand = Command.make("executor", {
  bootstrapFd: Flag.Literals("bootstrap-fd", ["3"]).pipe(
    Flag.withDescription("Read the desktop bootstrap envelope from fd3"),
    Flag.optional,
    Flag.withHidden,
  ),
}).pipe(
  Command.withDescription(
    "Start the local server and open its dashboard. First launch saves keys in the OS credential store.",
  ),
);

/** Start the same server without opening a browser. */
export const serveCommand = Command.make("serve").pipe(
  Command.withDescription("Start without opening a browser"),
);

/** Pair with an existing server without opening local storage. */
export const pairCommand = Command.make("pair").pipe(
  Command.withDescription("Print a new connection link for the running server"),
);

/** The desktop app pairs its own server; the CLI may not know its data directory or port. */
export const desktopPairing =
  "If Executor desktop is running, use its File > Open in browser menu item instead.";

/**
 * `executor pair` found no server on EXECUTOR_PORT, a server that refused it, or something there
 * that is not a working Executor server. Pairing only reads keys, so every message says what to
 * correct and that nothing was changed.
 * `keys` says whether the sent key was saved in `directory` or supplied as EXECUTOR_API_KEY.
 */
export class PairFailed extends Schema.TaggedError<PairFailed>()("PairFailed", {
  reason: Schema.Literals([
    "no-server",
    "key-rejected",
    "storage-unavailable",
    "unexpected-response",
  ]),
  port: Schema.Number,
  directory: Schema.String,
  keys: Schema.Literals(["saved", "supplied"]),
}) {
  get message() {
    const server = `127.0.0.1:${this.port}`;
    switch (this.reason) {
      case "no-server":
        return `No server answered on ${server}. Start Executor with \`executor\` or \`executor serve\`, or set EXECUTOR_PORT to the port it listens on. ${desktopPairing} Nothing was changed.`;
      case "key-rejected":
        return this.keys === "supplied"
          ? `The Executor server on ${server} did not accept the supplied EXECUTOR_API_KEY. Supply the key that server started with. Nothing was changed.`
          : `The Executor server on ${server} did not accept the API key saved in ${this.directory}. It may use another data directory: set EXECUTOR_DATA_DIR to the folder it uses. ${desktopPairing} If you ran \`executor rotate-key\`, restart the server to use the new key. Nothing was changed.`;
      case "storage-unavailable":
        return `The Executor server on ${server} could not save a connection link because its access storage is unavailable. Try again, and restart the server if this continues. Nothing was changed.`;
      case "unexpected-response":
        return `Something is listening on ${server}, but it did not answer as an Executor server. Check that EXECUTOR_PORT is the port Executor listens on. Nothing was changed.`;
    }
  }
}

/** Replace the saved local API key. A running server uses the new key after it restarts. */
export const rotateKeyCommand = Command.make("rotate-key").pipe(
  Command.withDescription(
    "Replace the saved local API key. Restart Executor to use it, then update clients that used the old key",
  ),
);

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
 * install switches versions only after the new one has passed its checks.
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
  ]),
  message: Schema.String,
}) {}

/** Executor 1 commands that Executor 2 does not have. */
export const LegacyCommandName = Schema.Literals([
  "web",
  "open",
  "daemon",
  "service",
  "install",
  "mcp",
  "call",
  "tools",
  "resume",
  "server",
  "login",
  "docs",
]);
export type LegacyCommandName = typeof LegacyCommandName.Type;

// Until Executor 2 has a background service, `service` and `install` point at `executor serve`.
const backgroundService =
  "Executor 2 cannot run as a background service yet. Keep `executor serve` running while your agents use Executor.";
const mcpOverHttp =
  "Start the server with `executor` or `executor serve`, then point your client at its /mcp endpoint, http://127.0.0.1:4312/mcp by default.";
const toolsOverMcp = `Executor 2 runs tools through MCP. ${mcpOverHttp}`;
const serverTarget = ["base-url", "server", "scope"];

/**
 * What to run instead of each Executor 1 command, and the flags Executor 1 accepted on it and its
 * subcommands: `switches` take no value, `values` take one. Declaring them lets an invocation such
 * as `executor web --foreground` reach the replacement instead of an unknown-flag error.
 */
const legacy: Readonly<
  Record<
    LegacyCommandName,
    {
      readonly replacement: string;
      readonly switches: ReadonlyArray<string>;
      readonly values: ReadonlyArray<string>;
    }
  >
> = {
  web: {
    replacement:
      "In Executor 2, run `executor` to start the local server and open its dashboard. If the server is already running, run `executor pair` and open the link it prints.",
    switches: ["foreground"],
    values: ["port", "hostname", "allowed-host", "auth-token", "scope"],
  },
  open: {
    replacement:
      "In Executor 2, run `executor pair` while the server is running, then open the connection link it prints.",
    switches: [],
    values: [],
  },
  daemon: {
    replacement:
      "Executor 2 has no daemon. Run `executor serve` to start the local server without opening a browser, and keep it running.",
    switches: ["foreground"],
    values: ["port", "hostname", "allowed-host", "auth-token", "base-url", "scope"],
  },
  service: { replacement: backgroundService, switches: ["boot"], values: ["port"] },
  install: { replacement: backgroundService, switches: ["boot"], values: ["port"] },
  mcp: {
    replacement: `Executor 2 serves MCP over HTTP from the running server. ${mcpOverHttp}`,
    switches: ["no-artifacts", "search-tools"],
    values: ["scope", "elicitation-mode", "mode"],
  },
  call: { replacement: toolsOverMcp, switches: [], values: serverTarget },
  tools: {
    replacement: toolsOverMcp,
    switches: [],
    values: ["namespace", "limit", "query", ...serverTarget],
  },
  resume: {
    replacement: toolsOverMcp,
    switches: [],
    values: ["execution-id", "action", "content", ...serverTarget],
  },
  server: {
    replacement:
      "Executor 2 has no server profiles. App commands take `--host`, agents connect to a server's /mcp endpoint, and `executor rotate-key` replaces `executor server rotate-token`.",
    switches: ["default"],
    values: ["display-name", "kind", "header-env"],
  },
  login: {
    replacement: `In Executor 2, run \`executor apps login --host ${hostedExecutorOrigin}\` to sign in to hosted Executor for app commands.`,
    switches: ["no-browser"],
    values: ["name", ...serverTarget],
  },
  docs: {
    replacement: "The documentation is at https://executor.sh/docs.",
    switches: [],
    values: [],
  },
};

/** An Executor 1 command was run; the message names the Executor 2 replacement. */
export class LegacyCommand extends Schema.TaggedError<LegacyCommand>()("LegacyCommand", {
  command: LegacyCommandName,
}) {
  get message() {
    return `\`executor ${this.command}\` is an Executor 1 command. ${legacy[this.command].replacement}`;
  }
}

/**
 * Executor 1's commands, accepted by exact name with any words and Executor 1 flags after them,
 * such as `service install --port 4788`. Unlisted, with hidden flags, so help and typo suggestions
 * show only Executor 2 commands and a legacy command's help shows only its replacement.
 */
export const legacyCommands = LegacyCommandName.literals.map((name) =>
  Command.make(name, {
    words: Argument.String("words").pipe(Argument.variadic()),
    flags: [
      ...legacy[name].switches.map((flag) =>
        Flag.Boolean(flag).pipe(Flag.optional, Flag.withHidden),
      ),
      ...legacy[name].values.map((flag) =>
        Flag.String(flag).pipe(Flag.atLeast(0), Flag.withHidden),
      ),
    ],
  }).pipe(Command.withDescription(legacy[name].replacement), Command.unlisted),
);
