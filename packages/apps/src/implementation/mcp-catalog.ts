/** Revisioned MCP metadata is persistent; selected executables remain invocation-owned. */
import { cacheKey } from "@executor-js/app-cache";
import { Duration, Effect, Schema } from "effect";
import type { AppCache, CacheLoadContext } from "../contracts/cache.ts";
import type { DynamicTools } from "../contracts/dynamic-tools.ts";
import { McpError, McpToolMetadata, McpToolsOptions } from "../contracts/mcp.ts";
import { JsonObject, type JsonValue } from "../contracts/schema.ts";
import { wrap } from "./schema.ts";
import { mcpClientEffect } from "./mcp.ts";
import { adaptMcpTool } from "./mcp-tools.ts";
import { protocolOperations, type OperationKinds } from "./protocol-operations.ts";
import { nativeOperation } from "./operations.ts";

/** Metadata policy for HTTP/SSE sources. A missing cache keeps discovery invocation-local. */
export interface McpCatalogOptions extends McpToolsOptions {
  readonly cache?: AppCache;
  readonly freshFor?: Duration.Input;
  readonly staleFor?: Duration.Input;
  /** Await a new catalog before returning; use at an explicit logical connection/refresh boundary. */
  readonly revalidate?: boolean;
}

const schema = <A>(decoder: Schema.Decoder<A>) => wrap(decoder, false);
const Manifest = Schema.Struct({ revision: Schema.String, pages: Schema.Int });
const Page = Schema.Array(McpToolMetadata);
const invoke = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error });
const invalid = () => new McpError({ phase: "discover", reason: "invalid_response" });

/** Construction opens no transport unless explicit revalidation is requested. */
export const mcpCatalog = (options: McpCatalogOptions, kinds: OperationKinds) =>
  Effect.gen(function* () {
    // Header names are case-insensitive. Hash all request identity, including credentials,
    // before persistence; custom callers cannot accidentally share two authentication scopes.
    const parsed = yield* Schema.decodeUnknownEffect(McpToolsOptions)(options).pipe(
      Effect.mapError(() => new McpError({ phase: "connect", reason: "invalid_input" })),
    );
    const headers: Record<string, string> = {};
    new Headers(parsed.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const id = yield* cacheKey({ url: parsed.url, headers, accountId: parsed.accountId ?? null });
    const key: JsonValue = ["mcp-catalog-v1", id, "current"];
    const part = (revision: string, kind: string, name: string | number): JsonValue => [
      "mcp-catalog-v1",
      id,
      revision,
      kind,
      name,
    ];
    const cache = options.cache;
    const changed = cache === undefined ? undefined : invoke(() => cache.invalidate(key));
    const client = yield* mcpClientEffect(options, changed);
    const freshFor = options.freshFor ?? "5 minutes";
    const staleFor = options.staleFor ?? "5 minutes";
    const retention =
      Duration.toMillis(Duration.fromInputUnsafe(freshFor)) +
      Duration.toMillis(Duration.fromInputUnsafe(staleFor)) +
      300_000;
    const local = yield* Effect.cached(client.list);
    const refresh = (context: CacheLoadContext) =>
      Effect.gen(function* () {
        // The loader owns its signal even when it outlives the foreground request.
        const source = yield* mcpClientEffect(
          { ...parsed, signal: context.signal },
          invoke(() => context.cache.invalidate(key)),
        );
        const tools = yield* source.list;
        const revision = crypto.randomUUID();
        let pages = 0;
        let page: JsonObject[] = [];
        let pageBytes = 0;
        let batch: { key: JsonValue; value: JsonValue }[] = [];
        let batchBytes = 0;
        const flush = () =>
          invoke(async () => {
            if (batch.length) await context.cache.write(batch, retention);
            batch = [];
            batchBytes = 0;
          });
        const append = (entry: { key: JsonValue; value: JsonValue }) =>
          Effect.gen(function* () {
            const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
            if (batch.length && (batch.length >= 64 || batchBytes + bytes > 4_000_000))
              yield* flush();
            batch.push(entry);
            batchBytes += bytes;
          });
        const pageOut = () =>
          Effect.gen(function* () {
            if (!page.length) return;
            yield* append({ key: part(revision, "page", pages++), value: page });
            page = [];
            pageBytes = 0;
          });
        for (const tool of tools) {
          // Optional wire fields can decode to undefined; persisted values are strictly JSON.
          const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
            JSON.stringify(tool),
          );
          const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
          if (page.length && (page.length >= 64 || pageBytes + bytes > 500_000)) yield* pageOut();
          yield* append({ key: part(revision, "tool", tool.name), value });
          page.push(value);
          pageBytes += bytes;
        }
        yield* pageOut();
        yield* flush();
        // The cache publishes this manifest only after all parts, under its fenced loader lease.
        return { revision, pages };
      });
    const getOptions = {
      key,
      schema: schema(Manifest),
      freshFor,
      staleFor,
      load: (context: CacheLoadContext) =>
        Effect.runPromise(refresh(context), { signal: context.signal }),
    };
    const current = () =>
      cache === undefined ? Effect.fail(invalid()) : invoke(() => cache.get(getOptions));
    if (options.revalidate) {
      if (cache === undefined) yield* local;
      else yield* invoke(() => cache.revalidate(getOptions));
    }
    const metadata = () =>
      Effect.gen(function* () {
        if (cache === undefined) return yield* local;
        const manifest = yield* current();
        const tools: McpToolMetadata[] = [];
        // Four pages fit the RPC byte budget even when a single tool is near the entry limit.
        for (let offset = 0; offset < manifest.pages; offset += 4) {
          const pages = yield* invoke(() =>
            cache.readMany(
              Array.from({ length: Math.min(4, manifest.pages - offset) }, (_, index) =>
                part(manifest.revision, "page", offset + index),
              ),
              schema(Page),
            ),
          );
          for (const page of pages) {
            if (page === undefined) return yield* invalid();
            tools.push(...page);
          }
        }
        return tools;
      });
    const kindOf = (tool: McpToolMetadata) =>
      Object.hasOwn(kinds, tool.name)
        ? (kinds[tool.name] ?? "mutation")
        : tool.annotations?.readOnlyHint === true
          ? "query"
          : "mutation";
    const qualified = (tool: McpToolMetadata) =>
      `${kindOf(tool) === "query" ? "queries" : "mutations"}.${tool.name}`;
    const dynamicTools: DynamicTools = {
      list: () =>
        metadata().pipe(
          Effect.map((tools) =>
            tools.map((tool) => ({
              name: qualified(tool),
              description: tool.description ?? tool.title ?? tool.name,
              inputSchema: tool.inputSchema,
              readOnly: kindOf(tool) === "query",
              ...(tool.title === undefined ? {} : { title: tool.title }),
              ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
              annotations: { ...tool.annotations, readOnlyHint: kindOf(tool) === "query" },
              ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
            })),
          ),
        ),
      resolve: (name) =>
        Effect.gen(function* () {
          if (!name.startsWith("queries.") && !name.startsWith("mutations.")) return undefined;
          const raw = name.slice(name.indexOf(".") + 1);
          const tool =
            cache === undefined
              ? (yield* local).find((tool) => tool.name === raw)
              : yield* current().pipe(
                  Effect.flatMap((manifest) =>
                    invoke(() =>
                      cache.read(part(manifest.revision, "tool", raw), schema(McpToolMetadata)),
                    ),
                  ),
                );
          if (tool === undefined || qualified(tool) !== name) return undefined;
          const adapted = yield* adaptMcpTool(client, tool);
          const operations = protocolOperations({ selected: adapted }, { selected: kindOf(tool) });
          return nativeOperation(operations.queries.selected ?? operations.mutations.selected);
        }),
    };
    return { dynamicTools };
  });
