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

export const dataDirectoryConfig = Config.String("EXECUTOR_DATA_DIR").pipe(
  Config.withDefault(".local/executor"),
);

export const defaultPort = 4312;
export const serviceRegistrationFile = "server.json";
export const serviceSettingsFile = "service.json";
export const serviceLockFile = ".server.lock";
export const serviceInfoPath = "/api/service";
export const serviceStopPath = "/api/service/stop";
export const servicePasswordVariable = "EXECUTOR_SERVICE_PASSWORD";

const Pid = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Port = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const ServiceRegistration = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  /** Loopback base URL, `http://127.0.0.1:<port>`. */
  url: Schema.String,
  pid: Pid,
  started: Schema.optional(Schema.String),
  boot: Schema.optional(Schema.String),
  password: Schema.String,
  group: Schema.optional(Schema.Boolean),
  browserOrigin: Schema.optional(Schema.String),
});
export type ServiceRegistration = typeof ServiceRegistration.Type;

export const EarlierServerRecord = Schema.Struct({
  pid: Pid,
  version: Schema.optional(Schema.String),
  url: Schema.String,
  command: Schema.Literals(["executor", "executor serve"]),
});

export const ServiceChallenge = Schema.String.check(Schema.isPattern(/^[\w-]{16,128}$/u));

export const ServiceInfo = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  pid: Pid,
  status: Schema.Literals(["starting", "ready", "stopping"]),
  proof: Schema.optional(Schema.String),
});
export type ServiceInfo = typeof ServiceInfo.Type;

export const ServiceSettings = Schema.Struct({
  port: Schema.optional(Port),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  disabled: Schema.optional(Schema.Boolean),
});
export type ServiceSettings = typeof ServiceSettings.Type;

export const ServiceSettingKey = Schema.Literals(["port", "env", "disabled"]);
export type ServiceSettingKey = typeof ServiceSettingKey.Type;

export const ServiceRefusal = Schema.fromJsonString(
  Schema.Struct({ executorService: Schema.Literal("refused"), reason: LocalConfigurationReason }),
);

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
  detail: Schema.String,
  configuration: Schema.optional(LocalConfigurationReason),
  standalone: Schema.optional(Schema.Boolean),
  url: Schema.optional(Schema.String),
  earlier: Schema.optional(Pid),
  variable: Schema.optional(Schema.Boolean),
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

export class ServiceSettingInvalid extends Schema.TaggedError<ServiceSettingInvalid>()(
  "ServiceSettingInvalid",
  { message: Schema.String },
) {}

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

export const servicePairCommand = Command.make("pair").pipe(
  Command.withDescription("Print a new connection link for the running server"),
);
export const serviceRotateKeyCommand = Command.make("rotate-key").pipe(
  Command.withDescription(
    "Replace the saved local API key. Run `executor service restart` to use it, then update clients that used the old key",
  ),
);

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the background Executor server that local clients share"),
);
