/** Framework documentation served by the management API. It describes this server's `apps` build. */
import { Context, Schema, type Effect } from "effect";
import type { HttpApiMiddleware } from "effect/http-api";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

const Entry = Schema.Struct({
  symbol: Schema.String,
  kind: Schema.String,
  summary: Schema.String,
  signatures: Schema.Array(Schema.String),
  definition: Schema.optionalKey(
    Schema.String.annotate({ description: "Declaration of a type, class or value." }),
  ),
  tags: Schema.Array(Schema.Struct({ name: Schema.String, text: Schema.String })),
  docs: Schema.String.annotate({
    description: "The app-authoring skill file that documents this symbol, such as tools.md.",
  }),
  source: Schema.String,
  related: Schema.Array(Schema.String),
  examples: Schema.Array(Schema.String),
});
const Example = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Identity = Schema.Struct({ version: Schema.String, digest: Schema.String });

/** The generated `framework-reference.json` shipped with the `apps` package. */
export const FrameworkReference = Schema.Struct({
  ...Identity.fields,
  entries: Schema.Array(Entry),
  examples: Schema.Array(Example),
});
export type FrameworkReference = typeof FrameworkReference.Type;

/**
 * The reference this server serves. Each host supplies it from its packaged assets, read on the
 * first lookup so a host can keep the large reference out of its startup.
 */
export class FrameworkDocumentation extends Context.Service<
  FrameworkDocumentation,
  Effect.Effect<FrameworkReference>
>()("app-management/FrameworkDocumentation") {}

/** The caller asked for a different framework build than this server serves. */
export class FrameworkVersionMismatch extends Schema.TaggedError<FrameworkVersionMismatch>()(
  "FrameworkVersionMismatch",
  { served: Identity, message: Schema.String },
  { httpApiStatus: 409 },
) {}

const Selection = {
  version: Schema.optional(Schema.String),
  digest: Schema.optional(Schema.String),
};

export const FrameworkSearchResult = Schema.Struct({
  reference: Identity,
  items: Schema.Array(
    Schema.Struct({
      symbol: Schema.String,
      kind: Schema.String,
      summary: Schema.String,
      docs: Schema.String,
    }),
  ),
  remaining: Schema.Int,
});

export const FrameworkDescribeResult = Schema.Struct({
  reference: Identity,
  entry: Schema.optionalKey(Entry),
  types: Schema.Array(Entry),
  examples: Schema.Array(Example),
  matches: Schema.Array(
    Schema.Struct({ symbol: Schema.String, kind: Schema.String, summary: Schema.String }),
  ),
});

/** The exact `apps` release this server runs. Every app declares it as `dependencies.apps`. */
export const FrameworkRelease = Schema.Struct({ version: Schema.NonEmptyString });

/**
 * Management API group for framework lookups. Tools are `framework.release`, `framework.search`
 * and `framework.describe`.
 */
export const frameworkApi = <I extends HttpApiMiddleware.AnyId, S>(
  prefix: "/api" | "/api/organizations/:organization",
  access: Context.Key<I, S>,
) => {
  const params =
    prefix === "/api" ? Schema.Struct({}) : Schema.Struct({ organization: Schema.NonEmptyString });
  return HttpApi.make("framework").add(
    HttpApiGroup.make("framework")
      .add(
        HttpApiEndpoint.get("release", "/framework/release", {
          params,
          success: FrameworkRelease,
        }).annotate(
          OpenApi.Description,
          'Read the exact apps framework version this server runs. Every app\'s package.json declares it as { "dependencies": { "apps": version } }; write that file beside index.ts before appManagement.create.',
        ),
        HttpApiEndpoint.get("search", "/framework/search", {
          params,
          query: {
            text: Schema.optional(Schema.String),
            offset: Schema.optional(Schema.NumberFromString.check(Schema.isInt())),
            ...Selection,
          },
          success: FrameworkSearchResult,
          error: FrameworkVersionMismatch,
        }).annotate(
          OpenApi.Description,
          "Find framework functions, methods, types and errors by name or task. Call framework.search({ query: { text } }); text goes inside query. Page with query.offset. These symbols are used in app source, not called as agent tools. Returns the exact framework version and digest for subsequent describes.",
        ),
        HttpApiEndpoint.get("describe", "/framework/describe", {
          params,
          query: {
            symbol: Schema.String.annotate({
              description:
                "A symbol from framework.search, such as apps.defineApp, apps/mcp.mcpRouter or AppMutation.withOptimisticUpdate.",
            }),
            ...Selection,
          },
          success: FrameworkDescribeResult,
          error: FrameworkVersionMismatch,
        }).annotate(
          OpenApi.Description,
          "Read a framework symbol's generated signatures, related types and JSDoc. Call framework.describe({ query: { symbol, version, digest } }); the symbol goes inside query. Pass the exact symbol from framework.search, or an unqualified name that ends exactly one symbol, such as defineApp for apps.defineApp. Pass the version and digest from framework.search to reject stale references. entry holds the summary, signatures or definition, and docs: the app-authoring skill file with behavior and examples. types holds the related types. When nothing matches, entry is absent and matches lists the closest symbols.",
        ),
      )
      .prefix(prefix)
      .middleware(access),
  );
};
