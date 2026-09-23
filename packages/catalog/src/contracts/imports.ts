/** Custom imports retain public configuration; credentials are connected after deployment. */
import { Schema } from "effect";
import { HttpUrl } from "@executor-js/sdk";

/** Credential-free URL syntax; the product decides which network destinations are allowed. */
export const ImportUrl = HttpUrl.check(
  Schema.makeFilter(
    (value) => {
      const url = new URL(value);
      return !url.username && !url.password && !url.hash && !url.search && !/[{}]/.test(value);
    },
    { expected: "an HTTP(S) URL without credentials, query parameters, fragments or placeholders" },
  ),
);
/** HTTP field names, without transport-controlled or cookie headers. */
export const ApiKeyHeader = Schema.String.check(
  Schema.isPattern(/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/),
  Schema.makeFilter(
    (name) =>
      ![
        "host",
        "content-length",
        "connection",
        "transfer-encoding",
        "cookie",
        "set-cookie",
      ].includes(name.toLowerCase()),
  ),
);
/** Explicit auth declarations never contain a token or OAuth client secret. */
export const ImportAuth = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("apiKey"),
    header: ApiKeyHeader,
    prefix: Schema.String.check(Schema.isPattern(/^[^\r\n{}]*$/)),
  }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    authorizationUrl: ImportUrl,
    tokenUrl: ImportUrl,
    scopes: Schema.Array(Schema.String),
  }),
]);
export type ImportAuth = typeof ImportAuth.Type;
/** Process arguments are passed directly, without a shell. Environment values belong to accounts. */
// oxlint-disable-next-line no-control-regex -- NUL is rejected on purpose
const ProcessText = Schema.String.check(Schema.isPattern(/^[^\u0000]*$/));
/** Portable process environment key; values are supplied through account credentials. */
export const EnvironmentName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
/** A process-based MCP app template; the product decides whether its runtime supports it. */
export const StdioAppInput = Schema.Struct({
  kind: Schema.Literal("mcp-stdio"),
  name: Schema.NonEmptyString,
  command: ProcessText.check(Schema.isMinLength(1)),
  args: Schema.Array(ProcessText),
  cwd: Schema.optional(ProcessText.check(Schema.isMinLength(1))),
  environment: Schema.Array(EnvironmentName).check(
    Schema.makeFilter((names) => new Set(names).size === names.length, {
      expected: "unique environment variable names",
    }),
  ),
  timeoutMs: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 300_000 })),
  ),
});
export type StdioAppInput = typeof StdioAppInput.Type;
/** Protocol-specific input prevents applying API definition settings to an MCP endpoint. */
export const RemoteCustomAppInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("mcp"),
    name: Schema.NonEmptyString,
    url: ImportUrl,
    auth: Schema.Union([
      ImportAuth,
      Schema.Struct({ type: Schema.Literals(["auto", "discoverOAuth"]) }),
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("graphql"),
    name: Schema.NonEmptyString,
    url: ImportUrl,
    auth: ImportAuth,
  }),
  Schema.Struct({
    kind: Schema.Literal("openapi"),
    name: Schema.NonEmptyString,
    url: ImportUrl,
    baseUrl: Schema.optional(ImportUrl),
  }),
]);
export type RemoteCustomAppInput = typeof RemoteCustomAppInput.Type;
/** Local imports also support process-based MCP servers. */
export const CustomAppInput = Schema.Union([StdioAppInput, RemoteCustomAppInput]);
export type CustomAppInput = typeof CustomAppInput.Type;
