/** Parsed local host configuration. The composition root resolves keys before this contract. */
import { UrlPolicy, defaultUrlPolicy, urlPolicyConfig } from "@executor-js/utils/url-policy";
import { Config, Effect, Option, Schema } from "effect";
import { McpLimits, defaultMcpLimits } from "@executor-js/mcp";
import { dataDirectoryConfig, defaultPort } from "./service.ts";

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
    Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/u)),
  ),
  /**
   * This process's background service password, random per process and accepted wherever the API
   * key is. The process sets it after reading the environment; it is never configured.
   */
  password: Schema.optional(Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(32)))),
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

/** The port of the running server a client such as `executor service pair` connects to. */
export const serverPortConfig = Config.Port("EXECUTOR_PORT").pipe(Config.withDefault(defaultPort));

/**
 * The port a server listens on: EXECUTOR_PORT, then the background service's `port` setting, then
 * 4312. 0 listens on any free port, as a private server does.
 */
export const listenPortConfig = (setting: number | undefined) =>
  Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
    "EXECUTOR_PORT",
  ).pipe(Config.withDefault(setting ?? defaultPort));
