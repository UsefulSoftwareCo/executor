import { UrlPolicy, defaultUrlPolicy, urlPolicyConfig } from "@executor-js/utils/url-policy";
import { Config, Effect, Option, Schema } from "effect";
import { McpLimits, defaultMcpLimits } from "@executor-js/mcp";
import { dataDirectoryConfig, defaultPort } from "./service.ts";

export const BrowserOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  }),
);

export const ServerConfig = Schema.Struct({
  directory: Schema.NonEmptyString,
  port: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 })),
  apiKey: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(32))),
  encryptionKey: Schema.RedactedFromValue(
    Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/u)),
  ),
  password: Schema.optional(Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(32)))),
  mcp: McpLimits.pipe(Schema.withDecodingDefault(Effect.succeed(defaultMcpLimits))),
  urlPolicy: UrlPolicy.pipe(Schema.withDecodingDefault(Effect.succeed(defaultUrlPolicy))),
  oauthClientMetadataUrl: Schema.optional(Schema.NonEmptyString),
  browserOrigin: Schema.optional(BrowserOrigin),
  webhookOrigin: Schema.optional(BrowserOrigin),
});
export type ServerConfig = typeof ServerConfig.Type;

export const config = Config.all({
  directory: dataDirectoryConfig,
  port: Config.Number("EXECUTOR_PORT").pipe(Config.withDefault(defaultPort)),
  apiKey: Config.Redacted("EXECUTOR_API_KEY"),
  encryptionKey: Config.Redacted("EXECUTOR_ENCRYPTION_KEY"),
  urlPolicy: urlPolicyConfig,
  oauthClientMetadataUrl: Config.String("EXECUTOR_OAUTH_CLIENT_METADATA_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  browserOrigin: Config.String("EXECUTOR_BROWSER_ORIGIN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  webhookOrigin: Config.String("EXECUTOR_WEBHOOK_ORIGIN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  mcp: Config.all({
    timeoutMs: Config.Number("EXECUTOR_MCP_TIMEOUT_MS").pipe(
      Config.withDefault(defaultMcpLimits.timeoutMs),
    ),
    maxToolCalls: Config.Number("EXECUTOR_MCP_MAX_TOOL_CALLS").pipe(
      Config.withDefault(defaultMcpLimits.maxToolCalls),
    ),
  }),
}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(ServerConfig))));

export const serverPortConfig = Config.Port("EXECUTOR_PORT").pipe(Config.withDefault(defaultPort));

export const listenPortConfig = (setting: number | undefined) =>
  Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
    "EXECUTOR_PORT",
  ).pipe(Config.withDefault(setting ?? defaultPort));
