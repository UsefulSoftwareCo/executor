/** Routers group operations. Keys form tool paths; each operation keeps its own kind. */
import { Schema, type Effect } from "effect";
import type { HostedTool, HostedToolSummary } from "./host.ts";
import type { AppOperation } from "./operations.ts";

/** Object keys that JavaScript gives special meaning, so no router may use them. */
export const reservedRouterKeys: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** One static path segment. Dots separate segments, so a key never contains one. */
export const RouterKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u),
  Schema.makeFilter((key) => !reservedRouterKeys.has(key)),
);

/** An image a client may show beside a router, such as an MCP server's own icon. Models never read it. */
export const RouterIcon = Schema.Struct({
  src: Schema.NonEmptyString,
  mimeType: Schema.optionalKey(Schema.String),
  sizes: Schema.optionalKey(Schema.Array(Schema.String)),
  theme: Schema.optionalKey(Schema.Literals(["light", "dark"])),
});
export type RouterIcon = typeof RouterIcon.Type;

/**
 * What an agent should know about a group of tools. `instructions` is published as a skill;
 * `tags` describes labels that tools in this router carry, such as OpenAPI tags.
 */
export const RouterMeta = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  instructions: Schema.optionalKey(Schema.String),
  icons: Schema.optionalKey(Schema.Array(RouterIcon)),
  tags: Schema.optionalKey(Schema.Record(Schema.NonEmptyString, Schema.String)),
});
export type RouterMeta = typeof RouterMeta.Type;

/** A statically declared router. Children are operations or further routers. */
export interface AppRouter {
  readonly kind: "router";
  readonly meta?: RouterMeta;
  readonly children: Readonly<Record<string, AppNode>>;
}

/**
 * A router whose tools are discovered when read, such as an MCP server or OpenAPI document.
 * Names are relative to the router and may contain dots. `readOnly: true` marks a query;
 * anything else is a mutation. Resolution never requires listing.
 */
export interface DynamicRouter {
  readonly kind: "dynamic";
  /** Metadata supplied by the source. Author metadata on the router takes precedence. */
  readonly meta?: () => Effect.Effect<RouterMeta, unknown>;
  readonly list: () => Effect.Effect<readonly HostedTool[], unknown>;
  readonly resolve: (name: string) => Effect.Effect<AppOperation | undefined, unknown>;
  /** Names and descriptions without schemas. Omitted sources reduce list(). */
  readonly summaries?: () => Effect.Effect<readonly HostedToolSummary[], unknown>;
  /** One tool's full metadata without listing. Omitted sources search list(). */
  readonly describe?: (name: string) => Effect.Effect<HostedTool | undefined, unknown>;
  /** Static author metadata, merged over the source's metadata. */
  readonly overrides?: RouterMeta;
}

/** Anything a router can contain. */
export type AppNode = AppOperation | AppRouter | DynamicRouter;
