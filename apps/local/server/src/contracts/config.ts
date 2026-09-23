/** Parsed local host configuration. The composition root resolves keys before this contract. */
import { UrlPolicy, defaultUrlPolicy, urlPolicyConfig } from "@executor-js/utils/url-policy";
import { Config, Effect, Option, Schema } from "effect";
import { McpLimits, defaultMcpLimits } from "@executor-js/mcp";

/** One explicit HTTPS origin for a private reverse proxy, without paths or credentials. */
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

/** Paths and secrets for one local Executor process. */
export const ServerConfig = Schema.Struct({
  directory: Schema.NonEmptyString,
  port: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 })),
  apiKey: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(32))),
  encryptionKey: Schema.RedactedFromValue(
    Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/)),
  ),
  mcp: McpLimits.pipe(Schema.withDecodingDefault(Effect.succeed(defaultMcpLimits))),
  urlPolicy: UrlPolicy.pipe(Schema.withDecodingDefault(Effect.succeed(defaultUrlPolicy))),
  oauthClientMetadataUrl: Schema.optional(Schema.NonEmptyString),
  browserOrigin: Schema.optional(BrowserOrigin),
  webhookOrigin: Schema.optional(BrowserOrigin),
});
/** Parsed configuration, with secrets redacted at ingress. */
export type ServerConfig = typeof ServerConfig.Type;

/** Read the environment at process startup. Local defaults only apply to directory and port. */
export const config = Config.all({
  directory: Config.String("EXECUTOR_DATA_DIR").pipe(Config.withDefault(".local/executor")),
  port: Config.Number("EXECUTOR_PORT").pipe(Config.withDefault(4312)),
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
    maxOutputBytes: Config.Number("EXECUTOR_MCP_MAX_OUTPUT_BYTES").pipe(
      Config.withDefault(defaultMcpLimits.maxOutputBytes),
    ),
  }),
}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(ServerConfig))));
