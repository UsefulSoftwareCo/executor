import { AppUiBaseUrl } from "@executor-js/hosted-server/app-ui/contracts";
import { Config, Effect, Option, Schema } from "effect";

export const dataDirectory = Config.NonEmptyString("EXECUTOR_DATA_DIR").pipe(
  Config.withDefault(".local/hosted"),
);

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

export const allowPrivateAppFetch = Config.Boolean("EXECUTOR_APPS_ALLOW_PRIVATE_FETCH").pipe(
  Config.withDefault(false),
);

export const npmRegistry = Config.String("EXECUTOR_NPM_REGISTRY").pipe(Config.option);

export class SelfHostSettingInvalid extends Schema.TaggedError<SelfHostSettingInvalid>()(
  "SelfHostSettingInvalid",
  { message: Schema.String },
) {}

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

export interface McpClientLimits {
  readonly total: number;
  readonly perUser: number;
}
export const defaultMcpClientLimits: McpClientLimits = { total: 512, perUser: 256 };
export const mcpClientLimits = Effect.gen(function* () {
  const limits: McpClientLimits = {
    total: yield* clientCount("EXECUTOR_MCP_CLIENTS", defaultMcpClientLimits.total),
    perUser: yield* clientCount("EXECUTOR_MCP_CLIENTS_PER_USER", defaultMcpClientLimits.perUser),
  };
  return limits;
});
