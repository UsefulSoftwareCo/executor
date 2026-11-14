/**
 * The background service: one Executor server per data directory, shared by every local client.
 *
 * A server that owns its port and data directory advertises itself in `server.json`. That file is
 * the whole discovery contract: a client reads it, asks the unauthenticated info route whether that
 * process answers, and uses the per-process password for everything else. `service.json` holds the
 * settings a background server starts with. Adapted from OpenCode's service model
 * (MIT, Copyright (c) 2025 opencode).
 */
import { Config, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { LocalConfigurationReason } from "./auth.ts";

/** The data directory, before it is resolved. The npm launcher defaults it to ~/.executor/v2/cli. */
export const dataDirectoryConfig = Config.String("EXECUTOR_DATA_DIR").pipe(
  Config.withDefault(".local/executor"),
);

/** The port a local server listens on when neither EXECUTOR_PORT nor the `port` setting is set. */
export const defaultPort = 4312;
/** Written by a running server in its data directory, mode 0600, replaced atomically. */
export const serviceRegistrationFile = "server.json";
/** Background service settings in the data directory, mode 0600. */
export const serviceSettingsFile = "service.json";
/** Held for a server's whole lifetime, so two servers never open one data directory. */
export const serviceLockFile = ".server.lock";
/** Unauthenticated identity and readiness of the server answering on a port. */
export const serviceInfoPath = "/api/service";
/** Ask the server to shut down gracefully; requires the registration password. */
export const serviceStopPath = "/api/service/stop";
/** Carries a parent-generated password to a `serve --stdio` child; the child removes it. */
export const servicePasswordVariable = "EXECUTOR_SERVICE_PASSWORD";

const Pid = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Port = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }));

/** `server.json`: which process serves this data directory and how to reach it. */
export const ServiceRegistration = Schema.Struct({
  /** Unique per server process; distinguishes a restart that reused a pid. */
  id: Schema.String,
  /** `EXECUTOR_BUILD_VERSION`, or `0.0.0-dev` for development builds. */
  version: Schema.String,
  /** Loopback base URL, `http://127.0.0.1:<port>`. */
  url: Schema.String,
  pid: Pid,
  /**
   * When that process started and on which boot, as its operating system records them, so a pid
   * another program has since been given is never taken for it. Absent when they could not be read,
   * and on Windows, where the pipe the data directory's lock records names the process instead.
   */
  started: Schema.optional(Schema.String),
  boot: Schema.optional(Schema.String),
  /** Random per process. Accepted wherever the local API key is accepted. */
  password: Schema.String,
  /**
   * The server leads its own process group, as a background server does, so stopping it signals
   * the group: its telemetry collector and app runtimes end with it. A foreground server shares
   * its terminal's group and is signalled alone.
   */
  group: Schema.optional(Schema.Boolean),
  /** `EXECUTOR_BROWSER_ORIGIN`, where its connection links point instead of `url`, when set. */
  browserOrigin: Schema.optional(Schema.String),
});
export type ServiceRegistration = typeof ServiceRegistration.Type;

/**
 * `server.json` as Executor servers wrote it before the background service. Such a server holds no
 * `.server.lock`, so while its process runs, no server or client may use the data directory.
 */
export const EarlierServerRecord = Schema.Struct({
  pid: Pid,
  version: Schema.optional(Schema.String),
  url: Schema.String,
  command: Schema.Literals(["executor", "executor serve"]),
});

/** `GET /api/service?challenge=<nonce>`: a fresh random nonce the server proves it can sign. */
export const ServiceChallenge = Schema.String.check(Schema.isPattern(/^[\w-]{16,128}$/u));

/**
 * `GET /api/service` answers before storage opens: 503 with `starting` while the server boots,
 * 200 with `ready` once every route is served, and 503 with `stopping` from when it is asked to
 * stop, or starts closing, until it exits. Anyone on the machine can read `id`, `pid` and
 * `version`, so they prove nothing. With a `challenge`, a server that has a password adds `proof`:
 * base64url HMAC-SHA256 of the challenge, keyed with its password. A client trusts the answer only
 * when `proof` matches the password in the registration it read, so it never sends that password
 * to a process that has not proved it knows it.
 */
export const ServiceInfo = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  pid: Pid,
  status: Schema.Literals(["starting", "ready", "stopping"]),
  proof: Schema.optional(Schema.String),
});
export type ServiceInfo = typeof ServiceInfo.Type;

/** `service.json`. Changing a setting stops the background server; the next client starts it. */
export const ServiceSettings = Schema.Struct({
  /** Port for the background server. `EXECUTOR_PORT` wins over it; the default is 4312. */
  port: Schema.optional(Port),
  /** Extra environment for the background server process. */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * `executor` and client commands without a named or remembered host run a private server for
   * the command instead, as with `--standalone`. `executor service start`, `executor service pair` and the
   * desktop still use the background server.
   */
  disabled: Schema.optional(Schema.Boolean),
});
export type ServiceSettings = typeof ServiceSettings.Type;

/** Settings `executor service get|set|unset` accept. */
export const ServiceSettingKey = Schema.Literals(["port", "env", "disabled"]);
export type ServiceSettingKey = typeof ServiceSettingKey.Type;

/**
 * The one line a background or private (`serve --stdio`) server writes on stderr, before its
 * message, when its key setup or its data directory refuses to start. The client that started it
 * moves the reason into ServiceFailed and leaves the line out of the message, so a desktop can
 * offer the matching recovery.
 */
export const ServiceRefusal = Schema.fromJsonString(
  Schema.Struct({ executorService: Schema.Literal("refused"), reason: LocalConfigurationReason }),
);

/** A server could not take its port or data directory, or a client could not reach one. */
export class ServiceFailed extends Schema.TaggedError<ServiceFailed>()("ServiceFailed", {
  reason: Schema.Literals([
    "port-in-use",
    "directory-in-use",
    "start-failed",
    "start-timeout",
    "stop-failed",
    "unreachable",
    "exited",
  ]),
  /**
   * Port, data directory, URL, the starting process's last output, or for `exited` how the
   * process ended, depending on `reason`.
   */
  detail: Schema.String,
  /** For `start-failed`: why the server's key setup or data directory refused, when it said. */
  configuration: Schema.optional(LocalConfigurationReason),
  /** For `start-failed`: the server was this command's private one, not the background Executor. */
  standalone: Schema.optional(Schema.Boolean),
  /**
   * For `directory-in-use`: where the registered server that uses the directory answers. Without
   * it, the holder is not registered, so `executor service stop` cannot stop it.
   */
  url: Schema.optional(Schema.String),
  /** For `directory-in-use`: the process of an Executor from before the background service. */
  earlier: Schema.optional(Pid),
  /** For `port-in-use`: the port came from EXECUTOR_PORT, which wins over the `port` setting. */
  variable: Schema.optional(Schema.Boolean),
  /** For `port-in-use`: an Executor server that is not this directory's registered one holds it. */
  executor: Schema.optional(Schema.Boolean),
}) {
  get message() {
    switch (this.reason) {
      case "port-in-use":
        return `Port ${this.detail} is already in use by ${this.executor === true ? "another Executor server, for another data directory" : "another program"}. ${
          this.variable === true
            ? `EXECUTOR_PORT is set to ${this.detail} and wins over the \`port\` setting: set EXECUTOR_PORT to another port, or unset it, then try again.`
            : "Choose another port with `executor service set port <port>`, then run `executor` again."
        }`;
      case "directory-in-use":
        if (this.earlier !== undefined)
          return `An Executor from before the background service (process ${this.earlier}) is using the data directory ${this.detail}${this.url === undefined ? "" : ` at ${this.url}`}. Stop it, for example with Ctrl+C where it runs, then try again. If no such Executor runs, remove ${serviceRegistrationFile} from that folder.`;
        if (this.url !== undefined)
          return `The background Executor already serves the data directory ${this.detail} at ${this.url}. Stop it with \`executor service stop\`, or set EXECUTOR_DATA_DIR to another folder.`;
        return `Another Executor is using the data directory ${this.detail}, and it is not the background Executor, so \`executor service stop\` cannot stop it. Quit Executor desktop if it is open, or stop the \`executor --standalone\` or \`executor serve\` that uses the folder where it runs, then try again. Or set EXECUTOR_DATA_DIR to another folder.`;
      case "start-failed":
        return `${this.standalone === true ? "This command's private Executor server could not start." : "The background Executor could not start."}${this.detail === "" ? "" : `\n${this.detail}`}`;
      case "exited":
        return `This command's private Executor server stopped (${this.detail}). Run the command again to start a new one.`;
      case "start-timeout":
        return "Timed out waiting for the background Executor to start. Run `executor service status` to check it, or `executor service restart` to try again.";
      case "stop-failed":
        return `The background Executor (process ${this.detail}) did not stop.`;
      case "unreachable":
        return `No Executor server answered at ${this.detail}. Check the URL and that the server is running.`;
    }
  }
}

/** `executor service set|unset|get` was given a value it cannot use. Nothing was changed. */
export class ServiceSettingInvalid extends Schema.TaggedError<ServiceSettingInvalid>()(
  "ServiceSettingInvalid",
  { message: Schema.String },
) {}

/** Shared by the default command: where to find the server this invocation uses. */
export const standaloneFlag = Flag.Boolean("standalone").pipe(
  Flag.withDescription("Run a private server for this command instead of the background service"),
  Flag.withDefault(false),
);
export const serverFlag = Flag.String("server").pipe(
  Flag.withDescription(
    "Connect to the Executor server at this URL instead of the background service",
  ),
  Flag.optional,
);

const key = Argument.Literals("key", ServiceSettingKey.literals).pipe(
  Argument.withDescription("Setting name: port, env or disabled"),
);

export const serviceStartCommand = Command.make("start").pipe(
  Command.withDescription(
    "Start the background server, or confirm that it runs, and print its URL",
  ),
);
export const serviceStopCommand = Command.make("stop").pipe(
  Command.withDescription("Stop the background server"),
);
export const serviceRestartCommand = Command.make("restart").pipe(
  Command.withDescription("Stop the background server and start it again"),
);
export const serviceStatusCommand = Command.make("status").pipe(
  Command.withDescription(
    "Print the background server's URL, version and process, `starting` or `stopping` before them while it starts or stops, or `stopped`",
  ),
);
export const serviceGetCommand = Command.make("get", {
  key: key.pipe(Argument.optional),
  name: Argument.String("name").pipe(
    Argument.withDescription("Variable name, for env"),
    Argument.optional,
  ),
}).pipe(Command.withDescription("Print the background server's settings, or one setting"));
export const serviceSetCommand = Command.make("set", {
  key,
  value: Argument.String("value").pipe(
    Argument.withDescription("New value; for env, the variable name"),
  ),
  envValue: Argument.String("env-value").pipe(
    Argument.withDescription("Variable value, for env"),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription("Change a setting. Stops the background server so it restarts with it"),
);
export const serviceUnsetCommand = Command.make("unset", {
  key,
  name: Argument.String("name").pipe(
    Argument.withDescription("Variable name, for env"),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription(
    "Remove a setting. Stops the background server so it restarts without it",
  ),
);

/** Pair with the running server without opening local storage. */
export const servicePairCommand = Command.make("pair").pipe(
  Command.withDescription("Print a new connection link for the running server"),
);
/** Replace the saved local API key. A running server uses the new key after it restarts. */
export const serviceRotateKeyCommand = Command.make("rotate-key").pipe(
  Command.withDescription(
    "Replace the saved local API key. Run `executor service restart` to use it, then update clients that used the old key",
  ),
);

/** `executor service …`; handlers are attached at the composition root. */
export const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the background Executor server that local clients share"),
);
