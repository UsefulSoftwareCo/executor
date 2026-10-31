/** Build a live catalog and execute code against configured apps. */
import { CodeMode, Namespace, Tool, ToolError, toolError } from "@opencode-ai/codemode";
import { parse, tokTypes, tokenizer, type Token } from "acorn";
import {
  Json,
  AppSlug,
  JsonObject,
  routerFailure,
  approvalRequired,
  ToolListingTimedOut,
  ToolSearchStale,
  ToolSearchUnavailable,
  resolveLinkedAccounts,
  AccountChoiceUnsupported,
  type App,
  type AppAccounts,
  type AppId,
  type Cursor,
  ToolName,
  type VersionId,
  type SearchableTools,
  type Tool as AppTool,
  type ToolRouter,
  type ToolSearchItem,
  type ToolSearchListing,
  type ToolSearchScope,
  type ToolSearchTarget,
} from "@executor-js/sdk/core";
import { Clock, Deferred, Duration, Effect, Option, Schema, Semaphore } from "effect";
import {
  diagnostic,
  diagnosticSummary,
  executionDiagnostic,
  failureDetail,
  failureReference,
  reportFailure,
  type FailureSite,
} from "./diagnostics.ts";
import { nearest } from "./suggestions.ts";
import { withOperationSpan } from "./telemetry.ts";
import type { McpAppAccounts } from "../contracts/targets.ts";
import type { McpBackend } from "../contracts/backend.ts";
import { accountSummary, accountsKey, discoveryAccounts } from "./accounts.ts";
import {
  AppAccountRequired,
  CallInput,
  CallRequest,
  CatalogUnavailable,
  type CallOutcome,
  type ExecuteResult,
  AppDiscoveryTimedOut,
  defaultMcpRuntimeLimits,
  defaultSearchLimits,
  DescribeInput,
  DescribeResult,
  SearchInput,
  SearchResult,
  SearchItem,
  searchPageBytes,
  type McpLimits,
  type SearchNamespace,
  type McpToolCall,
  type UnavailableApp,
} from "../contracts/execute.ts";

type Catalog = Record<string, Record<string, Tool.Tool>>;

/** Keywords that only document a schema; they never change which values it accepts. */
const annotations = new Set([
  "description",
  "title",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
/** Keywords that also judge `null`, so they cannot sit beside a `null` type unchanged. */
const nullConstraints = new Set([
  "$ref",
  "$defs",
  "definitions",
  "const",
  "enum",
  "not",
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
]);
const isNullSchema = (schema: Tool.JsonSchema) =>
  schema.type === "null" && Object.keys(schema).length === 1;

/**
 * Optional and nullable values arrive as `anyOf: [value, { type: "null" }]`. The signature
 * renderer documents only a property's own keywords, so the value's pattern, bounds, format and
 * description would be lost. `{ ...value, type: [value.type, "null"] }` accepts the same values,
 * because each remaining keyword of the value applies only to its own type, and it renders the
 * same TypeScript type with those constraints in its documentation.
 */
function documentedNullable(schema: Tool.JsonSchema): Tool.JsonSchema {
  const { anyOf, oneOf, ...rest } = schema;
  const members = anyOf === undefined ? oneOf : oneOf === undefined ? anyOf : undefined;
  if (members?.length !== 2 || !members.some(isNullSchema)) return schema;
  const value = members.find((member) => !isNullSchema(member));
  if (
    value === undefined ||
    typeof value.type !== "string" ||
    value.type === "null" ||
    Object.keys(value).some((key) => nullConstraints.has(key)) ||
    !Object.keys(rest).every((key) => annotations.has(key))
  )
    return schema;
  // The property's own documentation describes this use of the value, so it takes precedence.
  return { ...value, ...rest, type: [value.type, "null"] };
}

/**
 * Effect emits a property's documentation as `allOf: [{ description }]` when the property also
 * has constraints JSON Schema cannot express. A member holding only annotations accepts every
 * value, so moving its keywords onto the schema accepts the same values and puts the
 * documentation where the signature renderer reads it. Members whose keywords the schema
 * already has stay in `allOf`.
 */
function documentedAllOf(schema: Tool.JsonSchema): Tool.JsonSchema {
  const { allOf, ...rest } = schema;
  if (allOf === undefined) return schema;
  let merged: Tool.JsonSchema = rest;
  const kept: Array<Tool.JsonSchema> = [];
  for (const member of allOf) {
    const keys = Object.keys(member);
    if (keys.length > 0 && keys.every((key) => annotations.has(key) && !Object.hasOwn(merged, key)))
      merged = { ...merged, ...member };
    else kept.push(member);
  }
  return kept.length === 0 ? merged : { ...merged, allOf: kept };
}
const documented = (schema: Tool.JsonSchema) => documentedNullable(documentedAllOf(schema));

// Equivalent JSON Schema normalizations: the upstream signature renderer only renders index
// signatures when additionalProperties is a schema, rather than true, and documents only a
// property's own keywords.
function renderableSchema(input: Tool.JsonSchema): Tool.JsonSchema {
  return documented({
    ...input,
    ...(input.type === "object" && input.additionalProperties !== false
      ? {
          additionalProperties:
            typeof input.additionalProperties === "object"
              ? renderableSchema(input.additionalProperties)
              : {},
        }
      : {}),
    ...(input.properties === undefined
      ? {}
      : {
          properties: Object.fromEntries(
            Object.entries(input.properties).map(([name, schema]) => [
              name,
              renderableSchema(schema),
            ]),
          ),
        }),
    ...(input.items === undefined ? {} : { items: renderableSchema(input.items) }),
    ...(input.anyOf === undefined ? {} : { anyOf: input.anyOf.map(renderableSchema) }),
    ...(input.oneOf === undefined ? {} : { oneOf: input.oneOf.map(renderableSchema) }),
    ...(input.allOf === undefined ? {} : { allOf: input.allOf.map(renderableSchema) }),
    ...(input.$defs === undefined
      ? {}
      : {
          $defs: Object.fromEntries(
            Object.entries(input.$defs).map(([name, schema]) => [name, renderedDefinition(schema)]),
          ),
        }),
  });
}
/**
 * Rendered `$defs` entries by definition. A kept listing's tools share one object per distinct
 * definition, so each renders once, and listings are never mutated. A boolean schema is no key.
 */
const renderedDefinitions = new WeakMap<Tool.JsonSchema, Tool.JsonSchema>();
const renderedDefinition = (schema: Tool.JsonSchema) => {
  if (typeof schema !== "object" || schema === null) return renderableSchema(schema);
  const known = renderedDefinitions.get(schema);
  if (known !== undefined) return known;
  const rendered = renderableSchema(schema);
  renderedDefinitions.set(schema, rendered);
  return rendered;
};

const reserved = ["__proto__", "prototype", "constructor"];
// Codemode treats dots as namespace separators. Leave ordinary names readable;
// only escape characters needed to distinguish inaccessible/reserved segments.
function toolPath(name: string): string {
  return name
    .split(".")
    .map((segment) => {
      if (segment === "") return "%00";
      if (reserved.includes(segment)) return `%${segment}`;
      return segment.replaceAll("%", "%25");
    })
    .join(".");
}
/** The tool name a path below a target names: `toolPath` undone. */
const toolName = (path: string) =>
  path
    .split(".")
    .map((segment) =>
      segment === "%00"
        ? ""
        : segment.startsWith("%") && reserved.includes(segment.slice(1))
          ? segment.slice(1)
          : segment.replaceAll("%25", "%"),
    )
    .join(".");

function listTools<E extends Error>(
  backend: McpBackend<E>,
  app: AppId,
  accounts: AppAccounts,
  /** Records each page as progress. */
  paged: Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const list = (version?: VersionId, cursor?: Cursor) =>
      backend
        .listTools(
          { app, accounts, version, cursor, limit: 2_000 },
          // The catalog's watcher owns the pre-program wait bound. A dynamic namespace is governed
          // by CodeMode's execution deadline and must be allowed to join a listing already running.
          // Discovery keeps every page, so one page reads the listing once.
          { refreshStale: false, unboundedPages: true },
        )
        .pipe(Effect.tap(() => paged));
    let page = yield* list();
    // Later pages are pinned to the first page's version.
    const version = page.version;
    const tools: AppTool[] = [...page.items];
    while (page.next !== undefined) {
      page = yield* list(version, page.next);
      tools.push(...page.items);
    }
    return { tools, routers: page.routers, version };
  });
}

/**
 * Projections of kept tool listings. The SDK serves every page of a kept listing from the same
 * item objects, so a projection keyed by those objects lives exactly as long as the listing and
 * is not recomputed while the listing is reused. A listing evaluated again has new objects, and
 * nothing here outlives the listing it was derived from. Schemas are rendered only for tools a
 * program can call and tools a search or describe returns; ranking reads none of them.
 */
const renderedSchemas = new WeakMap<
  AppTool,
  { readonly input: Tool.JsonSchema; readonly output: Tool.JsonSchema | undefined }
>();
const renderSchemas = (tool: AppTool) =>
  Effect.gen(function* () {
    const known = renderedSchemas.get(tool);
    if (known !== undefined) return known;
    const input = yield* Schema.decodeUnknownEffect(JsonObject)(tool.inputSchema);
    const rendered = {
      input: renderableSchema(input),
      output: tool.outputSchema === undefined ? undefined : renderableSchema(tool.outputSchema),
    };
    renderedSchemas.set(tool, rendered);
    return rendered;
  });
type RenderedSchemas = Effect.Success<ReturnType<typeof renderSchemas>>;
/** An app as paths and results name it. Search results list each app once instead of labelling every tool with it. */
type Place = {
  readonly id: AppId;
  readonly slug: string;
  /** Canonical path below `tools`: the app's slug. */
  readonly path: string;
  readonly app: string;
  /** The labels of the linked accounts its calls use. */
  readonly accounts?: string;
};
/** A loaded app, whose tools a program can call. */
type Target = Place & {
  /** The app's routers by router path. The root router has path "". */
  readonly routers: ReadonlyMap<string, ToolRouter>;
  /**
   * The version its tools were listed from. Calls name no version: the host runs each on the
   * app's active version when the call starts, so a deploy earlier in the same program, or since
   * the app was loaded, is the one called.
   */
  readonly version: VersionId;
  /** The caller's linked accounts, which each call resolves its accounts from. */
  readonly linked: McpAppAccounts;
};
/** One callable tool of a loaded app. */
type Entry = {
  /** Canonical path below `tools`. */
  readonly path: string;
  readonly tool: AppTool;
  readonly target: Target;
};
/** An app whose current listing is kept as search rows. */
type SearchTarget = Place & {
  readonly listing: ToolSearchListing;
  /** The accounts the listing was read with. */
  readonly listed: AppAccounts;
};

/** CodeMode's signature for the schemas given, `(input: ...): Promise<...>`, without a path. */
const signatureOf = (
  input: Tool.JsonSchema,
  output: Tool.JsonSchema | typeof Schema.Json | undefined,
) => {
  const [described] = CodeMode.make({
    tools: {
      t: Tool.make({ description: "", input, output, execute: () => Effect.die("render only") }),
    },
  }).catalog();
  return described === undefined
    ? Effect.die("CodeMode described no signature for a one-tool catalog")
    : Effect.succeed(described.signature.slice("tools.t".length));
};

/**
 * CodeMode's multi-line type on one line without its documentation comments. Its renderer puts
 * each comment on lines of its own and ends every member with a comma; a comma before a closing
 * brace is dropped outside string literals.
 */
const singleLine = (pretty: string) => {
  const lines: Array<string> = [];
  let comment = false;
  for (const line of pretty.split("\n")) {
    const text = line.trim();
    if (comment) comment = text !== "*/";
    else if (text.startsWith("/**")) comment = !text.endsWith("*/");
    else lines.push(text);
  }
  const joined = lines.join(" ");
  let result = "";
  let quoted = false;
  for (let index = 0; index < joined.length; index++) {
    const character = joined.charAt(index);
    if (quoted) {
      if (character === "\\") {
        result += character + joined.charAt(index + 1);
        index++;
        continue;
      }
      quoted = character !== '"';
    } else if (character === '"') quoted = true;
    else if (character === "," && joined.startsWith(" }", index + 1)) continue;
    result += character;
  }
  return result;
};

/**
 * A tool's input type on one line, before any cut. CodeMode renders a tool without output as
 * `(input: <type>): Promise<void>`, or `(): Promise<void>` when its input is empty.
 */
const inputTypes = new WeakMap<RenderedSchemas, string>();
const inputType = (schemas: RenderedSchemas) =>
  Effect.gen(function* () {
    const known = inputTypes.get(schemas);
    if (known !== undefined) return known;
    const rendered = yield* signatureOf(schemas.input, undefined);
    const prefix = "(input: ";
    const suffix = "): Promise<void>";
    const computed =
      rendered === "(): Promise<void>"
        ? "{}"
        : rendered.startsWith(prefix) && rendered.endsWith(suffix)
          ? singleLine(rendered.slice(prefix.length, -suffix.length))
          : yield* Effect.die(`Unexpected CodeMode input signature: ${rendered.slice(0, 80)}`);
    inputTypes.set(schemas, computed);
    return computed;
  });
/** A tool's whole signature, `(input: ...): Promise<...>`, with its documentation. */
const signatures = new WeakMap<RenderedSchemas, string>();
const signature = (schemas: RenderedSchemas) =>
  Effect.gen(function* () {
    const known = signatures.get(schemas);
    if (known !== undefined) return known;
    const computed = yield* signatureOf(schemas.input, schemas.output ?? Schema.Json);
    signatures.set(schemas, computed);
    return computed;
  });

const cut = (text: string, characters: number) =>
  text.length <= characters ? text : `${text.slice(0, characters - 1)}…`;
/** The first line of a tool's description, or its title when it has none. */
const summary = (tool: AppTool) =>
  cut(
    tool.description
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ??
      tool.title ??
      "",
    defaultSearchLimits.descriptionChars,
  );

/** An app's namespace, as results list it once. */
const targetNamespace = (target: Place): SearchNamespace => ({
  path: CodeMode.toolExpression(target.path),
  app: target.app,
  ...(target.accounts === undefined ? {} : { accounts: target.accounts }),
});
/** The namespaces a tool's path sits in: its app, and its router when that has a title. */
const namespacesOf = (
  target: Place,
  router: ToolRouter | undefined,
): ReadonlyArray<SearchNamespace> => [
  targetNamespace(target),
  ...(router?.title === undefined
    ? []
    : [
        {
          path: CodeMode.toolExpression(`${target.path}.${toolPath(router.path)}`),
          app: target.app,
          router: router.title,
        },
      ]),
];
/** The router an entry's tool is listed under. */
const routerOf = (entry: Entry) =>
  entry.tool.router === undefined ? undefined : entry.target.routers.get(entry.tool.router);
const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

/** One `.name` or `["name"]` member of a tool expression. */
const expressionMember =
  /^(?:\.([A-Za-z_$][\w$]*)|\[("(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\])/;
/**
 * The canonical path of a name an agent passes: a tool expression such as
 * `tools["my-app"].issues` becomes `my-app.issues`, and `tools` alone
 * becomes "". Other names are already canonical paths.
 */
const canonical = (name: string) => {
  const trimmed = name.trim();
  if (trimmed !== "tools" && !trimmed.startsWith("tools.") && !trimmed.startsWith("tools["))
    return trimmed;
  const segments: Array<string> = [];
  for (let rest = trimmed.slice("tools".length); rest !== "";) {
    const member = expressionMember.exec(rest);
    if (member === null) return trimmed;
    const [matched, identifier, quoted] = member;
    segments.push(identifier ?? (quoted === undefined ? "" : String(JSON.parse(quoted))));
    rest = rest.slice(matched.length);
  }
  return segments.join(".");
};
/** Whether a canonical path lies in a canonical namespace. */
const within = (path: string, namespace: string) =>
  path === namespace || path.startsWith(`${namespace}.`);

/** Loads the apps named (or every app) and returns their tools in path order. */
type Described<E> = (
  names: ReadonlyArray<string> | "all",
) => Effect.Effect<ReadonlyArray<Entry>, E>;
/** Makes the apps named (or every app) searchable and returns their targets in path order. */
type Searchable<E> = (
  names: ReadonlyArray<string> | "all",
) => Effect.Effect<ReadonlyArray<SearchTarget>, E>;
/** Reports targets whose listing search no longer keeps, and searches without them from then. */
type Lost = (targets: ReadonlyArray<SearchTarget>) => Effect.Effect<void>;

/** Where a ranked tool sits: its target and its canonical path below `tools`. */
type Found = { readonly target: SearchTarget; readonly path: string };

/**
 * Ranked tools for one search. The backend ranks the rows of every target the namespace reaches,
 * so no listing is loaded to search. A query that is a tool's exact path, or its tool expression,
 * returns only that tool; a query without words lists every tool in target and name order.
 */
const rank = <E extends Error>(
  searchable: Searchable<E>,
  lost: Lost,
  search: McpBackend<E>["searchTools"],
  input: {
    readonly query?: string;
    readonly namespace?: string;
    readonly offset: number;
    readonly limit: number;
  },
) =>
  Effect.gen(function* () {
    const namespace = input.namespace === undefined ? "" : canonical(input.namespace);
    const { offset, limit } = input;
    // A target inside the namespace is searched whole; one the namespace lies in, below it.
    const targets = (yield* searchable(namespace === "" ? "all" : [namespace])).flatMap(
      (target): ReadonlyArray<{ target: SearchTarget; below: string | undefined }> =>
        namespace === "" || within(target.path, namespace)
          ? [{ target, below: undefined }]
          : within(namespace, target.path)
            ? [{ target, below: toolName(namespace.slice(target.path.length + 1)) }]
            : [],
    );
    const searched = (
      scope: (target: SearchTarget) => ReadonlyArray<ToolSearchScope>,
    ): ReadonlyArray<ToolSearchTarget> =>
      targets.map(({ target, below }) => ({
        listing: target.listing,
        app: target.id,
        accounts: target.listed,
        labels: [target.app, target.slug, target.accounts ?? ""],
        scopes: scope(target),
        ...(below === undefined ? {} : { below }),
      }));
    const query = (input.query ?? "").trim();
    const path = canonical(query);
    // The target an exact path names a tool of: the one with the longest path it lies below.
    const named = targets
      .filter(({ target }) => path.startsWith(`${target.path}.`))
      .reduce<SearchTarget | undefined>(
        (best, { target }) =>
          best === undefined || target.path.length > best.path.length ? target : best,
        undefined,
      );
    const name = named === undefined ? undefined : toolName(path.slice(named.path.length + 1));
    const exact = !Schema.is(ToolName)(name)
      ? undefined
      : yield* search({
          targets: searched((target) => [
            { readOnly: false, names: target === named ? [name] : [] },
          ]),
          query: "",
          offset: 0,
          limit: 1,
        });
    const ranked =
      exact !== undefined && exact.items.length > 0
        ? { items: offset === 0 ? exact.items : [], remaining: 0, missing: exact.missing }
        : yield* search({ targets: searched(() => []), query, offset, limit });
    // A listing this execution found and search no longer keeps is reported, so its app's
    // absence from the page is never mistaken for an app without matches.
    yield* lost(
      ranked.missing.flatMap((index) => {
        const target = targets[index]?.target;
        return target === undefined ? [] : [target];
      }),
    );
    // Each app has one target, so no item is listed under another.
    const items = ranked.items.flatMap(
      (found): ReadonlyArray<{ found: ToolSearchItem; first: Found }> => {
        const target = targets[found.target]?.target;
        return target === undefined
          ? []
          : [{ found, first: { target, path: `${target.path}.${toolPath(found.tool.name)}` } }];
      },
    );
    return { items, remaining: ranked.remaining + ranked.items.length - items.length };
  });

/**
 * Add ranked items to a page in rank order until the next would take it past its byte budget, so a
 * page stays concise; it always holds at least one match. Each item is rendered only when it is
 * reached.
 */
const fill = <A, B, E>(
  ranked: ReadonlyArray<A>,
  budget: number,
  used: number,
  render: (ranked: A, page: ReadonlyArray<B>) => Effect.Effect<B, E>,
  cost: (item: B) => number,
) =>
  Effect.gen(function* () {
    const items: Array<B> = [];
    for (const candidate of ranked) {
      const item = yield* render(candidate, items);
      const added = cost(item);
      if (items.length > 0 && used + added > budget) break;
      used += added;
      items.push(item);
    }
    return items;
  });

/**
 * One page of `tools.search`: exact callable paths, one-line descriptions and input types, with
 * each app and titled router listed once. `remaining` and `next` count from the last item the
 * page holds.
 */
const searchPage = <E extends Error>(
  searchable: Searchable<E>,
  lost: Lost,
  search: McpBackend<E>["searchTools"],
  input: typeof SearchInput.Type,
) =>
  Effect.gen(function* () {
    const offset = input.offset ?? 0;
    const ranked = yield* rank(searchable, lost, search, {
      ...input,
      offset,
      limit: input.limit ?? defaultSearchLimits.defaultItems,
    });
    const page = yield* fill(
      ranked.items,
      searchPageBytes,
      jsonBytes({ items: [], namespaces: [], remaining: 0, next: { ...input, offset } }),
      (
        { found, first },
        page: ReadonlyArray<{
          readonly item: typeof SearchItem.Type;
          readonly added: ReadonlyArray<SearchNamespace>;
        }>,
      ) =>
        Effect.gen(function* () {
          const type = yield* inputType(yield* renderSchemas(found.tool));
          const item = {
            path: CodeMode.toolExpression(first.path),
            description: summary(found.tool),
            input: cut(type, defaultSearchLimits.inputChars),
            ...(type.length > defaultSearchLimits.inputChars
              ? { inputTruncated: true as const }
              : {}),
          };
          // Each namespace is listed once, with the first item in it, and counts toward that item.
          const listed = new Set(page.flatMap(({ added }) => added.map((space) => space.path)));
          const added = new Map<string, SearchNamespace>();
          for (const space of namespacesOf(first.target, found.router))
            if (!listed.has(space.path)) added.set(space.path, space);
          return { item, added: [...added.values()] };
        }),
      ({ item, added }) =>
        jsonBytes(item) + 1 + added.reduce((sum, space) => sum + jsonBytes(space) + 1, 0),
    );
    const remaining = ranked.remaining + ranked.items.length - page.length;
    return {
      items: page.map(({ item }) => item),
      namespaces: page.flatMap(({ added }) => added),
      remaining,
      next: remaining > 0 ? { ...input, offset: offset + page.length } : null,
    };
  });

/**
 * One page of CodeMode's global `search()`, ranked as `tools.search` ranks, in the shape CodeMode's
 * own `search()` documents: each tool's expression, whole description and signature. Only the
 * tools on the page have their signatures rendered; `rendered` counts them.
 */
const globalSearchPage = <E extends Error>(
  searchable: Searchable<E>,
  lost: Lost,
  search: McpBackend<E>["searchTools"],
  input: CodeMode.SearchRequest,
  rendered: () => void,
) =>
  Effect.gen(function* () {
    const offset = input.offset ?? 0;
    const ranked = yield* rank(searchable, lost, search, {
      ...input,
      offset,
      limit: input.limit ?? defaultSearchLimits.defaultItems,
    });
    const items = yield* fill(
      ranked.items,
      searchPageBytes,
      jsonBytes({ items: [], remaining: 0, next: { offset } }),
      ({ found, first }) =>
        renderSchemas(found.tool).pipe(
          Effect.flatMap(signature),
          Effect.tap(() => Effect.sync(rendered)),
          Effect.map((typed) => {
            const path = CodeMode.toolExpression(first.path);
            return { path, description: found.tool.description, signature: `${path}${typed}` };
          }),
        ),
      (item) => jsonBytes(item) + 1,
    );
    const remaining = ranked.remaining + ranked.items.length - items.length;
    return { items, remaining, next: remaining > 0 ? { offset: offset + items.length } : null };
  });

/**
 * Full detail for exact tool paths. A path that names no tool is reported with the paths in its
 * app that are fewest edits away.
 */
const describeTools = <E>(described: Described<E>, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const named = paths.map(canonical);
    const entries = yield* described(named.filter((path) => path !== ""));
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const items: Array<(typeof DescribeResult.Type.items)[number]> = [];
    const namespaces = new Map<string, SearchNamespace>();
    const missing: Array<(typeof DescribeResult.Type.missing)[number]> = [];
    for (const [index, path] of paths.entries()) {
      const name = named[index] ?? "";
      const entry = byPath.get(name);
      if (entry === undefined) {
        const closest = nearest(
          name,
          entries
            .filter((candidate) => within(name, candidate.target.slug))
            .map((candidate) => candidate.path),
          3,
        );
        missing.push({ path, matches: closest.map((match) => CodeMode.toolExpression(match)) });
        continue;
      }
      items.push({
        path: CodeMode.toolExpression(entry.path),
        description: entry.tool.description,
        signature: yield* signature(yield* renderSchemas(entry.tool)),
      });
      for (const space of namespacesOf(entry.target, routerOf(entry)))
        namespaces.set(space.path, space);
    }
    return { items, namespaces: [...namespaces.values()], missing };
  });

/**
 * The apps a program names, which discovery loads before it runs, and why it may reach others.
 * Every tool path starts at the `tools` global, so a program whose uses of `tools` are all static
 * members, such as `tools.github` or `tools["my-app"]`, names only those apps (`static`). Any other
 * use (`tools[name]`, `Object.keys(tools)`, passing `tools` around) can reach any app (`dynamic`),
 * and so can source that does not tokenize (`parse`; CodeMode then reports its parse error). The
 * program loads such an app when it first reaches it. A program that names apps statically and
 * uses CodeMode's global `search()` is `search`: the search ranks in the backend and loads nothing.
 */
export type Reach = {
  readonly apps: ReadonlySet<string>;
  readonly reason: "static" | "search" | "dynamic" | "parse";
};
export const programReach = (code: string) =>
  Effect.try({
    try: () =>
      // Acorn's declarations omit the token value it sets: cooked identifier and string text.
      Array.from(
        (parse(code, {
          ecmaVersion: "latest",
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
        }),
        tokenizer(code, {
          ecmaVersion: "latest",
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
        })),
        (token: Token & { readonly value?: unknown }) => ({
          type: token.type,
          value: typeof token.value === "string" ? token.value : undefined,
        }),
      ),
    catch: () => "parse" as const,
  }).pipe(
    Effect.map((tokens): Reach => {
      const at = (index: number) => tokens[index] ?? { type: tokTypes.eof, value: undefined };
      const member = (index: number) =>
        at(index).type === tokTypes.dot || at(index).type === tokTypes.questionDot;
      const apps = new Set<string>();
      let searched = false;
      let dynamic = false;
      for (const [index, token] of tokens.entries()) {
        if (token.type !== tokTypes.name || member(index - 1)) continue;
        if (token.value === "search") searched = true;
        if (token.value !== "tools") continue;
        // tools.slug and tools?.slug; property names may be keywords.
        const name = at(index + 2);
        if (
          member(index + 1) &&
          name.value !== undefined &&
          (name.type === tokTypes.name || name.type.keyword !== undefined)
        ) {
          apps.add(name.value);
          continue;
        }
        // tools["slug"] and tools?.["slug"]
        const open = at(index + 1).type === tokTypes.questionDot ? index + 2 : index + 1;
        const key = at(open + 1);
        if (
          at(open).type === tokTypes.bracketL &&
          key.type === tokTypes.string &&
          key.value !== undefined &&
          at(open + 2).type === tokTypes.bracketR
        ) {
          apps.add(key.value);
          continue;
        }
        dynamic = true;
      }
      return { apps, reason: dynamic ? "dynamic" : searched ? "search" : "static" };
    }),
    Effect.orElseSucceed((): Reach => ({ apps: new Set(), reason: "parse" })),
  );

type ListedApp = Pick<App, "id" | "name" | "slug">;
/**
 * One app's discovery: why it failed, that a requirement has no linked account (it then exposes
 * no tools), or what was read with the accounts discovery lists it with.
 */
type Discovered<A> =
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "unlinked" }
  | { readonly kind: "loaded"; readonly linked: McpAppAccounts; readonly value: A };

/**
 * Discover apps on demand within one execution. Listing apps is cheap; listing an app's accounts
 * and tools can mean evaluating thousands of definitions or reaching an upstream server, so each
 * app is discovered at most once and only when the program or its search needs it. The backend
 * may serve a tool listing it kept from an earlier execution; its rendered schemas and search
 * projections are then reused too. Everything else is per execution.
 */
function catalog(
  backend: McpBackend<Error>,
  progress: ExecutionProgress,
  /** Completes at the execution deadline; dynamic loads must stop in the program phase. */
  programDeadline: Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const {
      discoveryConcurrency: concurrency,
      discoveryWaitMs,
      discoveryIdleMs,
    } = defaultMcpRuntimeLimits;
    const slots = yield* Semaphore.make(concurrency);
    // Every failure this catalog reports names the trace of the request driving it then.
    const site = (operation: FailureSite["operation"]): FailureSite => ({
      operation,
      reference: progress.reference,
    });
    // Listings share one app runtime, so how long one takes depends on the others. Discovery
    // gives up on an app only when no listing has completed for a while, not on a per-app clock.
    let progressed = yield* Clock.currentTimeMillis;
    const settled = Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        progressed = now;
      }),
    );
    /** Listings each app is running, when it started its first, and when it was given up on. */
    const running = new Map<AppId, number>();
    const started = new Map<AppId, number>();
    const stopped = new Map<AppId, number>();
    const stops = new Map<AppId, Deferred.Deferred<number>>();
    const stopOf = (app: AppId) => {
      const known = stops.get(app);
      if (known !== undefined) return known;
      const created = Deferred.makeUnsafe<number>();
      stops.set(app, created);
      return created;
    };
    /** Give up on an app: its running listings stop and its queued ones fail without running. */
    const stop = (app: AppId) =>
      Effect.gen(function* () {
        if (stopped.has(app)) return;
        const now = yield* Clock.currentTimeMillis;
        stopped.set(app, now);
        yield* Deferred.succeed(stopOf(app), now);
      });
    const timedOut = (app: AppId, at: number) =>
      new AppDiscoveryTimedOut({ app, elapsedMs: at - (started.get(app) ?? at) });
    // The agent reads a failed listing in the response; it reports as the same REST read would.
    // Discovery giving up on an app is its own wait bound, not a failure: the listing keeps running.
    const unloaded = (error: Error) =>
      Schema.is(AppDiscoveryTimedOut)(error) ? Effect.void : recordFailure(progress, error);
    // A listing holds a permit while it runs and stops with the rest of its app. Once an app is
    // given up on, its queued listings fail without running.
    const discover = <A, E, R>(name: string, app: AppId, work: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const queued = yield* Clock.currentTimeMillis;
        return yield* slots.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.annotateCurrentSpan("executor.discovery.wait_ms", now - queued);
            const at = stopped.get(app);
            if (at !== undefined) return yield* Effect.fail(timedOut(app, at));
            if (!started.has(app)) started.set(app, now);
            running.set(app, (running.get(app) ?? 0) + 1);
            return yield* work.pipe(
              Effect.tap(() => settled),
              Effect.raceFirst(
                Deferred.await(stopOf(app)).pipe(
                  Effect.flatMap((at) => Effect.fail(timedOut(app, at))),
                ),
              ),
              Effect.ensuring(Effect.sync(() => running.set(app, (running.get(app) ?? 1) - 1))),
            );
          }),
        );
      }).pipe(withOperationSpan(name));
    const apps = yield* backend
      .listApps({ toolsOnly: true })
      .pipe(withOperationSpan("mcp.discovery.apps"));
    yield* Effect.annotateCurrentSpan({
      "executor.discovery.apps": apps.length,
      "executor.discovery.concurrency": concurrency,
    });
    const counts = new Map<string, number>();
    for (const app of apps) counts.set(app.slug, (counts.get(app.slug) ?? 0) + 1);
    const unique = (app: ListedApp) => Schema.is(AppSlug)(app.slug) && counts.get(app.slug) === 1;
    const tools: Catalog = Object.create(null);
    /**
     * Why an app, or a target or router of it, is unavailable, as each reader found it: discovery
     * loading its tools for the program and describe, search keeping its rows, and a search or
     * describe that named an app exposing no tools. Each reader keeps its own entries, so one
     * never hides another's; the same failure found twice is reported once.
     */
    const failures = new Map<AppId, Array<typeof UnavailableApp.Type>>();
    const searchFailures = new Map<AppId, Array<typeof UnavailableApp.Type>>();
    const revealed = new Map<AppId, Array<typeof UnavailableApp.Type>>();
    // Tool path prefixes that expose no tools in this execution, and those that do. A call is
    // attributed to the longest matching prefix, so a typo inside a loaded namespace stays unknown.
    const namespaces: Namespaces = new Map();
    /** The version each loaded namespace's tools came from. */
    const loadedFrom = new Map<string, VersionId>();
    /** The app and accounts each loaded app's tools were listed with. */
    const loadedWith = new Map<string, { readonly app: AppId; readonly accounts: AppAccounts }>();
    const unavailableOf = (app: AppId) => {
      const seen = new Set<string>();
      return [
        ...(failures.get(app) ?? []),
        ...(searchFailures.get(app) ?? []),
        ...(revealed.get(app) ?? []),
      ].filter((entry) => {
        const key = JSON.stringify([entry.router, entry.name, entry.reason]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const unavailableApps = () => apps.flatMap((app) => unavailableOf(app.id));
    /**
     * Report an app that exposes no tools, such as one that needs an account, once a search or
     * describe names it; otherwise its empty result would look like an app with no tools. A call
     * already reports why in its error, and unnamed apps stay quiet: most members never set up
     * most of their organization's account apps.
     */
    const reveal = (entry: typeof UnavailableApp.Type) =>
      Effect.sync(() => {
        const app = apps.find((candidate) => candidate.id === entry.app);
        if (app === undefined || (!failures.has(app.id) && !searchFailures.has(app.id))) return;
        if (unavailableOf(app.id).includes(entry)) return;
        const shown = revealed.get(app.id) ?? [];
        revealed.set(app.id, shown);
        shown.push(entry);
        progress.unavailableApps = unavailableApps();
      });
    /** Each loaded app's tools, for describe and for the program's catalog. */
    const listed = new Map<string, ReadonlyArray<Entry>>();
    /** Each searchable app's target. */
    const indexed = new Map<string, ReadonlyArray<SearchTarget>>();
    /**
     * Call an entry's tool with the caller's linked accounts, as a program's call and a direct
     * call both do. Calls no longer choose accounts: one that passes `$accounts` is refused before
     * it runs, unless the tool declares `$accounts` as its own input.
     */
    const call =
      (entry: Entry) =>
      (input: unknown): Effect.Effect<Json, ToolError> =>
        Schema.decodeUnknownEffect(Json)(input).pipe(
          Effect.mapError(() => toolError("Tool arguments must be JSON")),
          Effect.flatMap((input) =>
            Effect.gen(function* () {
              if (Schema.is(JsonObject)(input) && Object.hasOwn(input, accountsKey)) {
                const schemas = yield* renderSchemas(entry.tool);
                if (schemas.input.properties?.[accountsKey] === undefined)
                  return yield* new AccountChoiceUnsupported({ app: entry.target.id });
              }
              const accounts = yield* resolveLinkedAccounts({
                app: entry.target.id,
                version: entry.target.version,
                // The host fills app requirements from the app links.
                appLinks: {},
                userLinks: entry.target.linked,
              });
              const result = yield* backend.callTool({
                app: entry.target.id,
                accounts,
                tool: entry.tool.name,
                kind: entry.tool.readOnly === true ? "query" : "mutation",
                input,
              });
              if (result.status !== "completed") return yield* approvalRequired(result);
              // The tool's result says it failed, as an MCP server's `isError` does. The program
              // still gets the whole result; the call is reported as a failure.
              if (result.toolError === true) yield* toolReportedError(progress);
              return result.value;
            }).pipe(Effect.mapError((error) => toolError(diagnostic(error, site("call"))))),
          ),
        );
    /** The program's own tool for an entry, built when the program's catalog takes its app. */
    const program = (entry: Entry) =>
      renderSchemas(entry.tool).pipe(
        Effect.map((schemas) =>
          Tool.make({
            description: entry.tool.description,
            input: schemas.input,
            output: schemas.output ?? Schema.Json,
            execute: call(entry),
          }),
        ),
      );

    /** Each app's linked accounts, listed at most once per execution. A failure is recorded once. */
    const accountsOf = new Map(
      yield* Effect.forEach(apps, (app) =>
        Effect.cached(
          discover("mcp.discovery.accounts", app.id, backend.listAccounts({ app: app.id })).pipe(
            Effect.tapError(unloaded),
          ),
        ).pipe(Effect.map((linked) => [app.id, linked] as const)),
      ),
    );
    /**
     * Read something of an app with the accounts discovery lists it with, recording why it has
     * nothing.
     */
    const discoverApp = <A>(
      app: ListedApp,
      name: string,
      read: (accounts: AppAccounts) => Effect.Effect<A, Error>,
    ): Effect.Effect<Discovered<A>> =>
      Effect.gen(function* () {
        if (!unique(app))
          return {
            kind: "failed",
            error: !Schema.is(AppSlug)(app.slug) ? "AppSlugInvalid" : "AppSlugAmbiguous",
          } as const;
        const listed = accountsOf.get(app.id);
        if (listed === undefined) return { kind: "unlinked" } as const;
        return yield* listed.pipe(
          Effect.flatMap((linked): Effect.Effect<Discovered<A>> => {
            const accounts = discoveryAccounts(linked);
            if (accounts === undefined) return Effect.succeed({ kind: "unlinked" });
            return discover(name, app.id, read(accounts)).pipe(
              Effect.map((value): Discovered<A> => ({ kind: "loaded", linked, value })),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  // This app's listing has run for longer than discovery waits, or recently
                  // timed out. Give up on the app now, as discovery would after waiting.
                  if (Schema.is(ToolListingTimedOut)(error)) yield* stop(app.id);
                  yield* unloaded(error);
                  return { kind: "failed", error: diagnostic(error, site("discover")) } as const;
                }),
              ),
            );
          }),
          Effect.catch((error) =>
            Effect.succeed({ kind: "failed", error: diagnostic(error, site("discover")) } as const),
          ),
        );
      });
    const placeOf = (app: ListedApp, linked: McpAppAccounts): Place => {
      const accounts = accountSummary(linked);
      return {
        id: app.id,
        slug: app.slug,
        path: app.slug,
        app: app.name,
        ...(accounts === "" ? {} : { accounts }),
      };
    };
    const routerFailures = (
      app: ListedApp,
      version: VersionId,
      routers: ReadonlyArray<ToolRouter>,
    ) =>
      routers.flatMap((router) =>
        router.error === undefined
          ? []
          : [
              {
                // The app's own router failed only for some of its accounts: its tools stay
                // callable, so the failure is reported without closing the app's namespace.
                namespace: router.path === "" ? undefined : `${app.slug}.${toolPath(router.path)}`,
                entry: {
                  app: app.id,
                  name:
                    router.path === "" ? app.name : `${app.name} ${router.title ?? router.path}`,
                  router: router.path,
                  reason: diagnostic(
                    routerFailure({ app: app.id, version }, router.error),
                    site("discover"),
                  ),
                },
              },
            ],
      );
    /**
     * An app whose requirement has no account the caller linked exposes no tools. A call into it
     * fails with that reason, and a search or describe that names it lists it (see `reveal`).
     * Unnamed, it stays quiet: most members never set up most of their organization's apps.
     */
    const accountRequired = (app: ListedApp) => ({
      app: app.id,
      name: app.name,
      reason: diagnostic(new AppAccountRequired({ app: app.id }), site("discover")),
    });

    const project = (
      app: ListedApp,
      discovered: Discovered<Effect.Success<ReturnType<typeof listTools>>>,
    ) =>
      Effect.sync(() => {
        const failed: Array<typeof UnavailableApp.Type> = [];
        failures.set(app.id, failed);
        if (discovered.kind === "failed") {
          const entry = { app: app.id, name: app.name, reason: discovered.error };
          failed.push(entry);
          if (unique(app)) namespaces.set(app.slug, entry);
          return;
        }
        if (discovered.kind === "unlinked") {
          namespaces.set(app.slug, accountRequired(app));
          tools[app.slug] = {};
          return;
        }
        const { linked, value: catalog } = discovered;
        const namespace = app.slug;
        namespaces.set(namespace, "available");
        loadedFrom.set(namespace, catalog.version);
        const accounts = discoveryAccounts(linked);
        if (accounts !== undefined) loadedWith.set(namespace, { app: app.id, accounts });
        // A router that could not list its tools is reported like an app, at its own namespace,
        // so a call into it explains why instead of reporting an unknown tool.
        for (const { namespace, entry } of routerFailures(app, catalog.version, catalog.routers)) {
          failed.push(entry);
          if (namespace !== undefined) namespaces.set(namespace, entry);
        }
        const described: Target = {
          ...placeOf(app, linked),
          routers: new Map(catalog.routers.map((router) => [router.path, router])),
          version: catalog.version,
          linked,
        };
        listed.set(
          app.slug,
          catalog.tools.map((tool) => ({
            path: `${namespace}.${toolPath(tool.name)}`,
            tool,
            target: described,
          })),
        );
      });

    /**
     * Keep a search's target and why it is unavailable, beside what discovery found when it
     * loaded the app: an app that loaded can still fail to keep its search rows. A search names
     * only the app's own namespace, which `reveal` reads, and only when discovery has not.
     */
    const projectSearch = (app: ListedApp, discovered: Discovered<SearchableTools>) =>
      Effect.sync(() => {
        const failed: Array<typeof UnavailableApp.Type> = [];
        searchFailures.set(app.id, failed);
        const found: Array<SearchTarget> = [];
        if (discovered.kind === "failed")
          failed.push({ app: app.id, name: app.name, reason: discovered.error });
        else if (discovered.kind === "unlinked") {
          if (!namespaces.has(app.slug)) namespaces.set(app.slug, accountRequired(app));
        } else {
          const { linked, value: searchable } = discovered;
          for (const { entry } of routerFailures(app, searchable.version, searchable.routers))
            failed.push(entry);
          // The app's earlier tools are still searched; this says why they may be out of date.
          if (searchable.stale !== undefined)
            failed.push({
              app: app.id,
              name: app.name,
              reason: diagnostic(
                new ToolSearchStale({
                  app: app.id,
                  listedAt: searchable.stale.listedAt,
                  cause: searchable.stale.failure.description,
                }),
                site("discover"),
              ),
            });
          found.push({
            ...placeOf(app, linked),
            listing: searchable.listing,
            listed: searchable.accounts,
          });
        }
        const whole = failed[0];
        if (found.length === 0 && whole !== undefined && !namespaces.has(app.slug))
          namespaces.set(app.slug, whole);
        indexed.set(app.slug, found);
      });

    const reported = Effect.sync(() => {
      progress.unavailableApps = unavailableApps();
    });
    // Each app is discovered at most once, by whichever of the program or a describe needs it
    // first, and made searchable at most once, by the first search that reaches it.
    const discovered = yield* Effect.forEach(apps, (app) =>
      Effect.cached(
        discoverApp(app, "mcp.discovery.tools", (accounts) =>
          listTools(backend, app.id, accounts, settled),
        ).pipe(
          Effect.flatMap((result) => project(app, result)),
          Effect.andThen(reported),
        ),
      ).pipe(Effect.map((load) => ({ app, load }))),
    );
    const searchedApps = yield* Effect.forEach(apps, (app) =>
      Effect.cached(
        discoverApp(app, "mcp.discovery.search", (accounts) =>
          backend.searchableTools(
            { app: app.id, accounts },
            // Search reads every app's rows; refreshing aged ones would load each app's Worker.
            { reportRunningAfterMillis: discoveryWaitMs, refreshStale: false },
          ),
        ).pipe(
          Effect.flatMap((result) => projectSearch(app, result)),
          Effect.andThen(reported),
        ),
      ).pipe(Effect.map((load) => ({ app, load }))),
    );
    /**
     * Wait for the selected apps. After `discoveryWaitMs`, once no listing has completed for
     * `discoveryIdleMs`, give up on every selected app still running a listing, however many
     * there are. Apps still queued then start, with a new idle period.
     */
    const load = (
      selected: ReadonlyArray<{ readonly app: ListedApp; readonly load: Effect.Effect<void> }>,
    ) =>
      Effect.gen(function* () {
        const began = yield* Clock.currentTimeMillis;
        let restarted = began;
        const watch: Effect.Effect<never> = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const due = Math.max(
            began + discoveryWaitMs,
            Math.max(progressed, restarted) + discoveryIdleMs,
          );
          if (now < due) {
            yield* Effect.sleep(Duration.millis(due - now));
            return yield* watch;
          }
          const stalled = selected.filter(({ app }) => (running.get(app.id) ?? 0) > 0);
          yield* Effect.annotateCurrentSpan("executor.discovery.stopped", stalled.length);
          for (const { app } of stalled) yield* stop(app.id);
          restarted = now;
          return yield* watch;
        });
        yield* Effect.raceFirst(
          Effect.forEach(selected, ({ load }) => load, { concurrency: "unbounded", discard: true }),
          watch,
        );
      });
    /** Dynamic namespaces run while CodeMode has the program turn. Discovery's idle stop is only
     * for pre-program reads; CodeMode's deadline interrupts this load in the program phase. */
    const loadForProgram = (
      selected: ReadonlyArray<{ readonly app: ListedApp; readonly load: Effect.Effect<void> }>,
    ) =>
      Effect.raceFirst(
        Effect.forEach(selected, ({ load }) => load, { concurrency: "unbounded", discard: true }),
        programDeadline.pipe(Effect.andThen(Effect.interrupt)),
      );
    /** The apps the canonical names lie in, or every app. */
    const named = <A extends { readonly app: ListedApp }>(
      all: ReadonlyArray<A>,
      names: ReadonlyArray<string> | "all",
    ) =>
      names === "all" ? all : all.filter(({ app }) => names.some((name) => within(name, app.slug)));
    /** Report an app a search or describe names that exposes no tools. */
    const revealNamed = (selected: ReadonlyArray<{ readonly app: ListedApp }>) =>
      Effect.forEach(
        selected,
        ({ app }) => {
          const entry = namespaces.get(app.slug);
          return unique(app) && entry !== undefined && entry !== "available"
            ? reveal(entry)
            : Effect.void;
        },
        { discard: true },
      );
    const byPath = <A extends { readonly path: string }>(left: A, right: A) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

    /**
     * The tools of every app the canonical names lie in, once those apps are loaded. A name is an
     * app slug, a router below it, or a tool path. Entries are in path order.
     */
    const described = (names: ReadonlyArray<string> | "all") =>
      Effect.gen(function* () {
        const selected = named(discovered, names);
        yield* load(selected);
        if (names !== "all") yield* revealNamed(selected);
        const entries = selected
          .flatMap(({ app }) => (unique(app) ? (listed.get(app.slug) ?? []) : []))
          .sort(byPath);
        yield* Effect.annotateCurrentSpan({
          "executor.discovery.apps": selected.length,
          "executor.discovery.tools": entries.length,
        });
        return entries;
      }).pipe(withOperationSpan("mcp.describe.discovery"));
    /**
     * Report targets whose listing search no longer keeps, as discovery reports a target it could
     * not load, and leave them out of later searches.
     */
    const lost: Lost = (targets) =>
      Effect.sync(() => {
        if (targets.length === 0) return;
        for (const target of targets) {
          const app = apps.find((candidate) => candidate.id === target.id);
          if (app === undefined) continue;
          const kept = indexed.get(app.slug);
          if (kept !== undefined)
            indexed.set(
              app.slug,
              kept.filter((candidate) => candidate.listing !== target.listing),
            );
          const failed = searchFailures.get(app.id) ?? [];
          searchFailures.set(app.id, failed);
          failed.push({
            app: app.id,
            name: app.name,
            reason: diagnostic(
              new ToolSearchUnavailable({ app: app.id, reason: "removed" }),
              site("discover"),
            ),
          });
        }
        progress.unavailableApps = unavailableApps();
      });
    /**
     * The searchable targets of every app the canonical names lie in, in path order. Searching
     * ranks their rows in the backend; no listing is loaded here unless its rows are missing.
     */
    const searchable = (names: ReadonlyArray<string> | "all") =>
      Effect.gen(function* () {
        const selected = named(searchedApps, names);
        yield* load(selected);
        if (names !== "all") yield* revealNamed(selected);
        const targets = selected
          .flatMap(({ app }) => (unique(app) ? (indexed.get(app.slug) ?? []) : []))
          .sort(byPath);
        yield* Effect.annotateCurrentSpan({
          "executor.discovery.apps": selected.length,
          "executor.discovery.targets": targets.length,
        });
        return targets;
      }).pipe(withOperationSpan("mcp.search.discovery"));
    const reachable = (names: ReadonlySet<string>) =>
      discovered.filter(({ app }) => names.has(app.slug));
    const slugs = new Set(apps.map((app) => app.slug));
    /** Build the catalog of the loaded apps among `selected`, which the program can call. */
    const callable = (selected: ReadonlyArray<(typeof discovered)[number]>) =>
      Effect.forEach(
        selected,
        ({ app }) =>
          Effect.gen(function* () {
            const found = listed.get(app.slug);
            if (!unique(app) || found === undefined || app.slug in tools) return;
            const prefix = app.slug.length + 1;
            tools[app.slug] = Object.fromEntries(
              yield* Effect.forEach(found, (entry) =>
                program(entry).pipe(
                  Effect.map((tool) => [entry.path.slice(prefix), tool] as const),
                ),
              ),
            );
          }),
        { discard: true },
      );
    /**
     * The program's namespace of each app whose tools it does not hold yet. The app is discovered
     * and its tools built when the program first reaches it: calls one of its tools, or lists its
     * keys, however it names it. Discovery, its wait and its unavailable-app reporting are the
     * same as for an app the program names; an app that does not load leaves no namespace, so a
     * call into it reports why as before. Listing the keys of `tools` lists apps and loads none.
     */
    const lazy = yield* Effect.forEach(discovered, (selected) =>
      Effect.cached(
        Effect.gen(function* () {
          yield* loadForProgram([selected]);
          yield* callable([selected]);
          const loaded = tools[selected.app.slug];
          yield* Effect.annotateCurrentSpan(
            "executor.discovery.tools",
            loaded === undefined ? 0 : Object.keys(loaded).length,
          );
          return loaded;
        }).pipe(withOperationSpan("mcp.discovery.namespace")),
      ).pipe(Effect.map((open) => ({ app: selected.app, open }))),
    );
    /** Namespaces for the program over every app it does not hold, each loaded on first use. */
    const namespacesOnUse = (provide: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>) =>
      Object.fromEntries(
        lazy.flatMap(({ app, open }) =>
          unique(app) && !(app.slug in tools)
            ? [[app.slug, Namespace.lazy({ load: provide(open) })] as const]
            : [],
        ),
      );
    return {
      tools,
      namespaces,
      namespacesOnUse,
      load,
      callable,
      reachable,
      call,
      described,
      searchable,
      lost,
      unavailableApps,
      unknownTool: (error: CodeMode.Diagnostic) => unknownTool(error, loadedFrom, slugs),
      /**
       * Have the app a program named an unknown tool of checked for new tools. Its listing is read
       * as one that refreshes when it is past its freshness: the refresh runs the app, whose
       * cached tool list, such as an MCP server's, refreshes in turn once it is stale, and a
       * changed list makes every process list the app again. Nothing waits for that refresh.
       */
      recheck: (error: CodeMode.Diagnostic) => {
        const loaded = loadedWith.get(unknownPath(error)?.split(".")[0] ?? "");
        return loaded === undefined
          ? Effect.void
          : backend.listTools({ app: loaded.app, accounts: loaded.accounts, limit: 1 }).pipe(
              // A listing this read evaluates runs on as the host's background work, where
              // there is one, after the answer stops waiting for it.
              Effect.timeoutOption(recheckWaitMillis),
              Effect.ignore,
              Effect.withSpan("mcp.execute.recheck"),
            );
      },
    };
  });
}

/** How long an execute that named an unknown tool waits for the app's listing it rechecks. */
const recheckWaitMillis = 2_000;

/** Unavailable namespaces map to their reason; loaded ones are marked available. */
type Namespaces = Map<string, typeof UnavailableApp.Type | "available">;

/** What one execution has done so far, so a result assembled by its driver stays accurate. */
export type ExecutionProgress = {
  /** Calls admitted by the program, updated as each call starts and ends. */
  readonly calls: Array<{
    readonly name: string;
    outcome: McpToolCall["outcome"] | "running";
    durationMs?: number;
    /** The call returned a result that says the tool failed (`toolError`), so it did not succeed. */
    toolError?: true;
  }>;
  /** The call index each running tool fiber serves, so the driver can mark its approval wait. */
  readonly callFibers: Map<number, number>;
  /** `program` once discovery has finished and program code may run. */
  phase: "discovery" | "program";
  unavailableApps: ReadonlyArray<typeof UnavailableApp.Type>;
  /**
   * Failures to report. The program outlives the request that started it, so the request driving
   * it when they happen reports them, with its own reporter and trace.
   */
  readonly failures: Array<Error>;
  /**
   * The trace of the request driving the program, the reference of each failure the program
   * meets. Its driver sets it before the program runs again, so a failure after a resume names
   * the resume that reports it, not the request that started the program.
   */
  reference: string | undefined;
};
export const executionProgress = (reference: string | undefined): ExecutionProgress => ({
  calls: [],
  callFibers: new Map(),
  phase: "discovery",
  unavailableApps: [],
  failures: [],
  reference,
});
const recordFailure = (progress: ExecutionProgress, error: Error) =>
  Effect.sync(() => {
    progress.failures.push(error);
  });
/** Mark the call this fiber makes as one whose result says its tool failed. */
const toolReportedError = (progress: ExecutionProgress) =>
  Effect.map(Effect.fiberId, (fiber) => {
    const index = progress.callFibers.get(fiber);
    const call = index === undefined ? undefined : progress.calls[index];
    if (call !== undefined) call.toolError = true;
  });

/** The canonical path CodeMode's UnknownTool diagnostic names. */
const unknownPath = (error: CodeMode.Diagnostic) =>
  error.kind === "UnknownTool"
    ? /^(?:Unknown tool(?: namespace)? |Tool )'([^']*)'/.exec(error.message)?.[1]
    : undefined;

/**
 * Why a loaded app, or a slug no app had, has no such tool. Each execute lists apps when it
 * starts and loads an app's tools when it first reaches it, so an app deployed or created by the
 * program itself shows its new tools only in the next execute. CodeMode's own suggestion, that
 * the tool may have been removed, sends agents looking for a cause that is not there. A typo
 * cannot be told apart from a tool deployed later, so it gets the same message, which ends by
 * sending the agent to search.
 */
const unknownTool = (
  error: CodeMode.Diagnostic,
  loadedFrom: ReadonlyMap<string, VersionId>,
  slugs: ReadonlySet<string>,
) => {
  const path = unknownPath(error);
  if (path === undefined) return undefined;
  const segments = path.split(".");
  const slug = segments[0] ?? "";
  for (let length = segments.length; length > 0; length--) {
    const version = loadedFrom.get(segments.slice(0, length).join("."));
    if (version !== undefined)
      return `This execute loaded '${slug}' from version ${version} when it first reached the app. If the app was deployed after that, call its new tools in a new execute. If the tool was added to the service behind the app, Executor is checking the app for new tools now; they appear within a few minutes, so call it again in a new execute. Otherwise use search to find the app's tools.`;
  }
  if (!slugs.has(slug))
    return `No app '${slug}' existed when this execute started. If it was created or deployed during this execute, call it in a new execute. Otherwise use search to find available tools.`;
  return undefined;
};

/**
 * A call into an app that failed to load is not an unknown tool: report why the app is unavailable.
 * CodeMode names the unresolved canonical path in its UnknownTool diagnostic.
 */
const unavailableTarget = (error: CodeMode.Diagnostic, namespaces: Namespaces) => {
  const path = unknownPath(error);
  return path === undefined ? undefined : unavailableAt(path, namespaces);
};
/** The app or router a canonical path lies in, when it did not load. */
const unavailableAt = (path: string, namespaces: Namespaces) => {
  const segments = path.split(".");
  for (let length = segments.length; length > 0; length--) {
    const found = namespaces.get(segments.slice(0, length).join("."));
    if (found === "available") return undefined;
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Why a call into an app that did not load cannot run, as the agent reads it. */
const unavailableMessage = (unavailable: typeof UnavailableApp.Type) =>
  unavailable.reason.startsWith("{")
    ? unavailable.reason
    : `${unavailable.name} could not be loaded in this execution (${unavailable.reason}); its tools cannot be called until it loads.`;

/**
 * A snapshot for a result. A call still running when the execution ends is reported as
 * interrupted, and one whose result says its tool failed as a failure. A driver-assembled result
 * lists only calls whose start was recorded.
 */
export const reportedCalls = (progress: ExecutionProgress): Array<McpToolCall> =>
  progress.calls.flatMap((call) =>
    call === undefined
      ? []
      : [
          {
            name: call.name,
            outcome:
              call.outcome === "running"
                ? "interrupted"
                : call.outcome === "success" && call.toolError === true
                  ? "failure"
                  : call.outcome,
            ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
          },
        ],
  );

/** The phase a timed-out execution was in, so callers can tell slow discovery from a slow program. */
export const timeoutMessage = (timeoutMs: number, phase: "discovery" | "program") =>
  phase === "discovery"
    ? `Execution timed out after ${timeoutMs}ms while loading app tools; no program code ran.`
    : `Execution timed out after ${timeoutMs}ms; earlier tool calls may have completed.`;

/**
 * After the budget is spent, CodeMode interrupts the program and returns its calls and logs.
 * The driver waits this long for that result. If it does not arrive, the driver reports the
 * calls it recorded (without logs); the run's cleanup continues in the background either way.
 */
export const timeoutDeliveryMs = 1_000;

// CodeMode's execution timeout sleeps for exactly `timeoutMs`. End that sleep at the host's
// deadline, so CodeMode stops the program itself and returns the calls and logs it has so far.
// Every other sleep keeps real time.
const deadlineClock = (
  clock: Clock.Clock,
  timeoutMs: number,
  deadline: Effect.Effect<void>,
): Clock.Clock => ({
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
  currentTimeMillis: clock.currentTimeMillis,
  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
  currentTimeNanos: clock.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: (duration) =>
    Duration.toMillis(duration) === timeoutMs ? deadline : clock.sleep(duration),
});

/**
 * One execution's work. The run supplies its brokered backend, its limits, a `deadline` that
 * completes when the execution's budget is spent, and the progress its driver reports from.
 */
export type Program = (
  backend: McpBackend<Error>,
  limits: McpLimits,
  deadline: Effect.Effect<void>,
  progress: ExecutionProgress,
) => Effect.Effect<typeof ExecuteResult.Type>;

/** Run one CodeMode program as an execution. */
export const executeProgram =
  (code: string): Program =>
  (backend, limits, deadline, progress) =>
    runProgram(backend, limits, code, deadline, progress);

/**
 * Internal interpreter entry. `deadline` completes when the execution's budget is spent; the
 * caller decides whether that is wall time or active time. Discovery stops at the deadline;
 * a running program is stopped by CodeMode so its admitted calls and logs are returned.
 */
function runProgram(
  backend: McpBackend<Error>,
  limits: McpLimits,
  code: string,
  deadline: Effect.Effect<void>,
  progress: ExecutionProgress,
) {
  return Effect.suspend(() => {
    const failure = (kind: CodeMode.DiagnosticKind, message: string) => ({
      execution: executionDiagnostic({
        ok: false as const,
        error: { kind, message },
        toolCalls: reportedCalls(progress),
      }),
      unavailableApps: progress.unavailableApps,
    });
    return Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      // Tools run on the real clock; only CodeMode's own timeout follows the deadline.
      const tools: McpBackend<Error> = {
        ...backend,
        callTool: (input, options) =>
          backend.callTool(input, options).pipe(Effect.provideService(Clock.Clock, clock)),
      };
      // Discovery covers the apps the program names. The program loads any other app when it first
      // reaches it, and search ranks in the backend without loading apps' tools.
      const reach = yield* programReach(code);
      const loaded = yield* Effect.gen(function* () {
        const discovered = yield* catalog(tools, progress, deadline);
        const reachable = discovered.reachable(reach.apps);
        yield* Effect.annotateCurrentSpan({
          "executor.discovery.reachable": reachable.length,
          "executor.discovery.reach_reason": reach.reason,
        });
        yield* discovered.load(reachable);
        yield* discovered.callable(reachable);
        yield* Effect.annotateCurrentSpan({
          "executor.discovery.tools": Object.values(discovered.tools).reduce(
            (sum, entries) => sum + Object.keys(entries).length,
            0,
          ),
          "executor.discovery.unavailable": progress.unavailableApps.length,
        });
        return discovered;
      }).pipe(
        withOperationSpan("mcp.catalog"),
        Effect.map(Option.some),
        Effect.raceFirst(deadline.pipe(Effect.as(Option.none()))),
      );
      if (Option.isNone(loaded)) {
        yield* Effect.annotateCurrentSpan("executor.timeout.phase", "discovery");
        return failure("TimeoutExceeded", timeoutMessage(limits.timeoutMs, "discovery"));
      }
      const prepared = loaded.value;
      progress.phase = "program";
      // Discovery while the program runs is on the real clock, like tool calls.
      const real = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provideService(Clock.Clock, clock));
      // Signatures the program's global `search()` rendered for its pages.
      let searchSignatures = 0;
      const search = Tool.make({
        description:
          "Find app tools by words in their paths, descriptions and labels. Returns exact callable paths, one-line descriptions and input types, with each app and its linked accounts listed once. Use tools.search.describe for output types and whole descriptions.",
        input: SearchInput,
        output: SearchResult,
        execute: (input) =>
          real(searchPage(prepared.searchable, prepared.lost, tools.searchTools, input)),
      });
      const describe = Tool.make({
        description:
          "Read the whole description and TypeScript signature, with input and output types, of tools at exact paths from tools.search.",
        input: DescribeInput,
        output: DescribeResult,
        execute: ({ paths }) => real(describeTools(prepared.described, paths)),
      });
      const runtime = CodeMode.make({
        tools: {
          // Namespace loading must use CodeMode's deadline clock so a dynamic listing stall is
          // reported as a program timeout. The backend wrapper still gives actual tool calls the
          // real clock above.
          ...prepared.namespacesOnUse(<A, E>(effect: Effect.Effect<A, E>) => effect),
          ...prepared.tools,
          search,
          "search.describe": describe,
        },
        // CodeMode's global `search()` ranks as `tools.search` does, instead of an index of every
        // tool's signature.
        search: (input) =>
          real(
            globalSearchPage(prepared.searchable, prepared.lost, tools.searchTools, input, () => {
              searchSignatures += 1;
            }),
          ),
        // No output limit: the program's value and logs come back whole.
        limits: { timeoutMs: limits.timeoutMs, maxToolCalls: limits.maxToolCalls },
        // Both hooks run on the fiber that makes the call.
        onToolCallStart: ({ index, name }) =>
          Effect.map(Effect.fiberId, (fiber) => {
            progress.calls[index] = { name, outcome: "running" };
            progress.callFibers.set(fiber, index);
          }),
        onToolCallEnd: ({ index, outcome, durationMs }) =>
          Effect.map(Effect.fiberId, (fiber) => {
            progress.callFibers.delete(fiber);
            const call = progress.calls[index];
            if (call === undefined) return;
            // A call interrupted while it waited for approval was never resumed.
            if (!(outcome === "interrupted" && call.outcome === "awaiting-approval"))
              call.outcome = outcome;
            call.durationMs = durationMs;
          }),
      });
      const result = yield* runtime
        .execute(code)
        .pipe(
          Effect.provideService(Clock.Clock, deadlineClock(clock, limits.timeoutMs, deadline)),
          Effect.flatMap(Schema.decodeUnknownEffect(CodeMode.Result)),
        );
      // CodeMode records a call before its start hook runs; report every admitted call in order.
      result.toolCalls.forEach(({ name }, index) => {
        progress.calls[index] ??= { name, outcome: "interrupted" };
      });
      const timedOut = !result.ok && result.error.kind === "TimeoutExceeded";
      const unavailable = result.ok
        ? undefined
        : unavailableTarget(result.error, prepared.namespaces);
      if (unavailable !== undefined)
        yield* Effect.annotateCurrentSpan("executor.unavailable_app.called", true);
      const unknown =
        result.ok || unavailable !== undefined ? undefined : prepared.unknownTool(result.error);
      if (unknown !== undefined && !result.ok) yield* prepared.recheck(result.error);
      const execution = executionDiagnostic({
        ...result,
        ...(unknown === undefined || result.ok
          ? {}
          : { error: { ...result.error, suggestions: [unknown] } }),
        ...(unavailable === undefined
          ? {}
          : {
              error: {
                kind: "ToolFailure" as const,
                message: unavailableMessage(unavailable),
              },
            }),
        ...(timedOut
          ? {
              error: {
                kind: "TimeoutExceeded" as const,
                message: timeoutMessage(limits.timeoutMs, "program"),
              },
            }
          : {}),
        toolCalls: reportedCalls(progress),
      });
      if (timedOut) yield* Effect.annotateCurrentSpan("executor.timeout.phase", "program");
      // Signatures cost CPU per tool; a program renders them only for its global `search()` pages.
      yield* Effect.annotateCurrentSpan(
        "executor.codemode.signatures_rendered",
        runtime.signaturesRendered() + searchSignatures,
      );
      yield* Effect.annotateCurrentSpan("executor.outcome", execution.ok ? "completed" : "failed");
      return { execution, unavailableApps: prepared.unavailableApps() };
    }).pipe(
      Effect.catch((error) =>
        recordFailure(progress, error).pipe(
          Effect.as(
            failure(
              "ExecutionFailure",
              diagnostic(error, { operation: "discover", reference: progress.reference }),
            ),
          ),
        ),
      ),
    );
  });
}

/** A failed direct call, in the shape every outcome of a batch shares. */
const callFailure = (
  path: string,
  kind: CodeMode.DiagnosticKind,
  message: string,
  matches?: ReadonlyArray<string>,
): CallOutcome => ({
  path,
  ok: false,
  error: failureDetail({ kind, message }),
  ...(matches === undefined ? {} : { matches }),
});

/**
 * Call tools by exact path without a program. Each call runs the same catalog tool a program
 * would call, through the run's backend, so approvals and tool input pause and resume as they do
 * for execute. Calls run concurrently and fail independently, and each result comes back whole.
 */
export function callTools(input: typeof CallInput.Type): Program {
  return (backend, limits, deadline, progress) =>
    Effect.suspend(() => {
      const single = "path" in input.calls;
      const requests: ReadonlyArray<typeof CallRequest.Type> =
        "path" in input.calls ? [input.calls] : input.calls;
      const failure = (kind: CodeMode.DiagnosticKind, message: string) => ({
        execution: executionDiagnostic({
          ok: false as const,
          error: { kind, message },
          toolCalls: reportedCalls(progress),
        }),
        unavailableApps: progress.unavailableApps,
      });
      if (requests.length > limits.maxToolCalls)
        return Effect.succeed(
          failure(
            "ToolCallLimitExceeded",
            `One call accepts at most ${limits.maxToolCalls} tool calls; this one has ${requests.length}.`,
          ),
        );
      const named = requests.map(({ path }) => canonical(path));
      return Effect.gen(function* () {
        // Discovery loads only the apps the calls name.
        const loaded = yield* Effect.gen(function* () {
          const discovered = yield* catalog(backend, progress, deadline);
          const entries = yield* discovered.described(named.filter((path) => path !== ""));
          return { discovered, entries };
        }).pipe(
          withOperationSpan("mcp.catalog"),
          Effect.map(Option.some),
          Effect.raceFirst(deadline.pipe(Effect.as(Option.none()))),
        );
        if (Option.isNone(loaded)) {
          yield* Effect.annotateCurrentSpan("executor.timeout.phase", "discovery");
          return failure("TimeoutExceeded", timeoutMessage(limits.timeoutMs, "discovery"));
        }
        const { discovered, entries } = loaded.value;
        const byPath = new Map(entries.map((entry) => [entry.path, entry]));
        progress.phase = "program";
        const run = (request: typeof CallRequest.Type, index: number) =>
          Effect.gen(function* () {
            const path = named[index] ?? "";
            const entry = byPath.get(path);
            if (entry === undefined) {
              const unavailable = unavailableAt(path, discovered.namespaces);
              if (unavailable !== undefined)
                return callFailure(request.path, "ToolFailure", unavailableMessage(unavailable));
              const closest = nearest(
                path,
                entries
                  .filter((candidate) => within(path, candidate.target.slug))
                  .map((candidate) => candidate.path),
                3,
              );
              return callFailure(
                request.path,
                "UnknownTool",
                `No tool at ${request.path}. Use search to find exact paths.`,
                closest.map((match) => CodeMode.toolExpression(match)),
              );
            }
            const name = CodeMode.toolExpression(entry.path);
            const fiber = yield* Effect.fiberId;
            const started = yield* Clock.currentTimeMillis;
            progress.calls[index] = { name, outcome: "running" };
            progress.callFibers.set(fiber, index);
            const finish = (outcome: "success" | "failure") =>
              Effect.gen(function* () {
                const recorded = progress.calls[index];
                if (recorded === undefined) return;
                recorded.outcome = outcome;
                recorded.durationMs = (yield* Clock.currentTimeMillis) - started;
              });
            return yield* discovered
              .call(entry)(request.input)
              .pipe(
                Effect.matchEffect({
                  onSuccess: (value) =>
                    finish("success").pipe(Effect.as<CallOutcome>({ path: name, ok: true, value })),
                  onFailure: (error) =>
                    finish("failure").pipe(
                      Effect.as(callFailure(name, "ToolFailure", error.message)),
                    ),
                }),
                Effect.ensuring(Effect.sync(() => progress.callFibers.delete(fiber))),
              );
          });
        const outcomes = yield* Effect.forEach(requests, run, { concurrency: "unbounded" }).pipe(
          Effect.map(Option.some),
          Effect.raceFirst(deadline.pipe(Effect.as(Option.none()))),
        );
        if (Option.isNone(outcomes)) {
          yield* Effect.annotateCurrentSpan("executor.timeout.phase", "program");
          return failure("TimeoutExceeded", timeoutMessage(limits.timeoutMs, "program"));
        }
        yield* Effect.annotateCurrentSpan({
          "executor.call.count": requests.length,
          "executor.outcome": "completed",
        });
        return {
          execution: {
            ok: true as const,
            value: single ? (outcomes.value[0] ?? null) : outcomes.value,
            toolCalls: reportedCalls(progress),
          },
          unavailableApps: discovered.unavailableApps(),
        };
      }).pipe(
        Effect.catch((error) =>
          recordFailure(progress, error).pipe(
            Effect.as(
              failure(
                "ExecutionFailure",
                diagnostic(error, { operation: "discover", reference: progress.reference }),
              ),
            ),
          ),
        ),
      );
    });
}

/**
 * Read the caller's catalog outside any program, for the search and describe tools. Discovery
 * failures are reported as they are for a program; a failure to list apps fails the request.
 */
const readCatalog = <A>(
  backend: McpBackend<Error>,
  read: (discovered: Effect.Success<ReturnType<typeof catalog>>) => Effect.Effect<A, Error>,
) =>
  Effect.gen(function* () {
    const progress = executionProgress(yield* failureReference);
    // No program runs, so no program deadline stops a load.
    return yield* catalog(backend, progress, Effect.never).pipe(
      Effect.flatMap((discovered) =>
        read(discovered).pipe(Effect.map((value) => ({ value, discovered }))),
      ),
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach(progress.failures.splice(0), reportFailure, { discard: true }),
        ),
      ),
      Effect.catch((error) =>
        reportFailure(error).pipe(
          Effect.andThen(
            Effect.fail(
              new CatalogUnavailable({
                message: diagnosticSummary(error, {
                  operation: "discover",
                  reference: progress.reference,
                }),
              }),
            ),
          ),
        ),
      ),
    );
  });

/** The search tool: one ranked page of the caller's catalog, as tools.search returns it. */
export const searchCatalog = (backend: McpBackend<Error>, input: typeof SearchInput.Type) =>
  readCatalog(backend, (discovered) =>
    searchPage(discovered.searchable, discovered.lost, backend.searchTools, input),
  ).pipe(
    Effect.map(({ value, discovered }) => ({
      ...value,
      unavailableApps: discovered.unavailableApps(),
    })),
  );

/** The describe tool: full signatures for exact paths, as tools.search.describe returns them. */
export const describeCatalog = (backend: McpBackend<Error>, input: typeof DescribeInput.Type) =>
  readCatalog(backend, (discovered) => describeTools(discovered.described, input.paths)).pipe(
    Effect.map(({ value }) => value),
  );
