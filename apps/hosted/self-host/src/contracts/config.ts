/** Self-host storage configuration shared by the database, retained builds and diagnostics. */
import { AppUiBaseUrl } from "@executor-js/hosted-server/app-ui/contracts";
import { Config, Effect, Option, Schema } from "effect";

/** One persistent root; Docker supplies /app/data and source development uses .local/hosted. */
export const dataDirectory = Config.NonEmptyString("EXECUTOR_DATA_DIR").pipe(
  Config.withDefault(".local/hosted"),
);

/** Localhost works without DNS setup; production operators explicitly supply their app DNS base. */
export const appUiBaseUrl = (dashboardOrigin: string) =>
  Effect.gen(function* () {
    const configured = yield* Config.String("EXECUTOR_APP_UI_BASE_URL").pipe(Config.option);
    if (Option.isSome(configured))
      return yield* Schema.decodeUnknownEffect(AppUiBaseUrl)(configured.value);
    const dashboard = new URL(dashboardOrigin);
    if (dashboard.hostname !== "localhost" && dashboard.hostname !== "127.0.0.1") return undefined;
    dashboard.hostname = "localhost";
    return yield* Schema.decodeUnknownEffect(AppUiBaseUrl)(dashboard.origin);
  });

/**
 * App isolates reach only public addresses, the same as Executor Cloud. Requests for the
 * dashboard origin reach the product without the network, so the bundled Executor app does not
 * need this. Operators opt in to let app code reach other private destinations.
 */
export const allowPrivateAppFetch = Config.Boolean("EXECUTOR_APPS_ALLOW_PRIVATE_FETCH").pipe(
  Config.withDefault(false),
);

/** A registry mirror for app builds. Apps resolve their declared packages from the public npm registry by default. */
export const npmRegistry = Config.String("EXECUTOR_NPM_REGISTRY").pipe(Config.option);

/** An operator setting the server cannot start with. The message names the setting, never its value. */
export class SelfHostSettingInvalid extends Schema.TaggedError<SelfHostSettingInvalid>()(
  "SelfHostSettingInvalid",
  { message: Schema.String },
) {}

/** A whole number of at least 1, when set; otherwise `fallback`. */
const clientCount = (name: string, fallback: number) =>
  Effect.flatMap(Config.String(name).pipe(Config.option), (value) =>
    Option.isNone(value)
      ? Effect.succeed(fallback)
      : /^[1-9][0-9]*$/.test(value.value.trim())
        ? Effect.succeed(Number(value.value.trim()))
        : Effect.fail(
            new SelfHostSettingInvalid({
              message: `${name} must be a whole number of at least 1.`,
            }),
          ),
  );

/**
 * The MCP clients the server keeps protocol state for, one per API key or OAuth grant a member uses
 * (`mcpSessionKey`), and how many of them one member may hold. Past either, the least recently used
 * client without a request in flight or a paused program is forgotten, and its next request must
 * initialize again. Read at startup, so a count that is not a whole number of at least 1 stops the
 * server with an error naming the setting.
 */
export interface McpClientLimits {
  readonly total: number;
  readonly perUser: number;
}
/**
 * Measured in the image's product isolate: a client that has initialized holds about 170 to 240 KB
 * of heap, so 512 hold about 120 MB. Tool calls stayed under about 70 ms with up to about 660
 * clients kept and took 250 to 550 ms with 800. A member may hold half the list.
 */
export const defaultMcpClientLimits: McpClientLimits = { total: 512, perUser: 256 };
export const mcpClientLimits = Effect.gen(function* () {
  const limits: McpClientLimits = {
    total: yield* clientCount("EXECUTOR_MCP_CLIENTS", defaultMcpClientLimits.total),
    perUser: yield* clientCount("EXECUTOR_MCP_CLIENTS_PER_USER", defaultMcpClientLimits.perUser),
  };
  return limits;
});
