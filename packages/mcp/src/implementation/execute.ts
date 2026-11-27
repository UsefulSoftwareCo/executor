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
import { ToolCallRecorded, type McpBackend } from "../contracts/backend.ts";
import { accountSummary, accountsKey, discoveryAccounts } from "./accounts.ts";
import {
  AppAccountRequired,
  CallInput,
  callLogNote,
  CallRequest,
  CatalogUnavailable,
  type CallLog,
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

const annotations = new Set([
  "description",
  "title",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
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
  return { ...value, ...rest, type: [value.type, "null"] };
}

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
  paged: Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const list = (version?: VersionId, cursor?: Cursor) =>
      backend
        .listTools(
          { app, accounts, version, cursor, limit: 2_000 },
          { refreshStale: false, unboundedPages: true },
        )
        .pipe(Effect.tap(() => paged));
    let page = yield* list();
    const version = page.version;
    const tools: AppTool[] = [...page.items];
    while (page.next !== undefined) {
      page = yield* list(version, page.next);
      tools.push(...page.items);
    }
    return { tools, routers: page.routers, version };
  });
}

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
type Place = {
  readonly id: AppId;
  readonly slug: string;
  readonly path: string;
  readonly app: string;
  readonly accounts?: string;
};
type Target = Place & {
  readonly routers: ReadonlyMap<string, ToolRouter>;
  readonly version: VersionId;
  readonly linked: McpAppAccounts;
};
export type Entry = {
  readonly path: string;
  readonly tool: AppTool;
  readonly target: Target;
};
type SearchTarget = Place & {
  readonly listing: ToolSearchListing;
  readonly listed: AppAccounts;
};

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

const targetNamespace = (target: Place): SearchNamespace => ({
  path: CodeMode.toolExpression(target.path),
  app: target.app,
  ...(target.accounts === undefined ? {} : { accounts: target.accounts }),
});
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
const routerOf = (entry: Entry) =>
  entry.tool.router === undefined ? undefined : entry.target.routers.get(entry.tool.router);
const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

const expressionMember =
  /^(?:\.([A-Za-z_$][\w$]*)|\[("(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\])/;
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
const within = (path: string, namespace: string) =>
  path === namespace || path.startsWith(`${namespace}.`);

type Described<E> = (
  names: ReadonlyArray<string> | "all",
) => Effect.Effect<ReadonlyArray<Entry>, E>;
type Searchable<E> = (
  names: ReadonlyArray<string> | "all",
) => Effect.Effect<ReadonlyArray<SearchTarget>, E>;
type Lost = (targets: ReadonlyArray<SearchTarget>) => Effect.Effect<void>;

type Found = { readonly target: SearchTarget; readonly path: string };

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
    yield* lost(
      ranked.missing.flatMap((index) => {
        const target = targets[index]?.target;
        return target === undefined ? [] : [target];
      }),
    );
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

export type Reach = {
  readonly apps: ReadonlySet<string>;
  readonly reason: "static" | "search" | "dynamic" | "parse";
};
export const programReach = (code: string) =>
  Effect.try({
    try: () =>
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
        const name = at(index + 2);
        if (
          member(index + 1) &&
          name.value !== undefined &&
          (name.type === tokTypes.name || name.type.keyword !== undefined)
        ) {
          apps.add(name.value);
          continue;
        }
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
type Discovered<A> =
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "unlinked" }
  | { readonly kind: "loaded"; readonly linked: McpAppAccounts; readonly value: A };

function catalog(
  backend: McpBackend<Error>,
  progress: ExecutionProgress,
  programDeadline: Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const {
      discoveryConcurrency: concurrency,
      discoveryWaitMs,
      discoveryIdleMs,
    } = defaultMcpRuntimeLimits;
    const slots = yield* Semaphore.make(concurrency);
    const site = (operation: FailureSite["operation"]): FailureSite => ({
      operation,
      reference: progress.reference,
    });
    let progressed = yield* Clock.currentTimeMillis;
    const settled = Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        progressed = now;
      }),
    );
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
    const stop = (app: AppId) =>
      Effect.gen(function* () {
        if (stopped.has(app)) return;
        const now = yield* Clock.currentTimeMillis;
        stopped.set(app, now);
        yield* Deferred.succeed(stopOf(app), now);
      });
    const timedOut = (app: AppId, at: number) =>
      new AppDiscoveryTimedOut({ app, elapsedMs: at - (started.get(app) ?? at) });
    const unloaded = (error: Error) =>
      Schema.is(AppDiscoveryTimedOut)(error) ? Effect.void : recordFailure(progress, error);
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
    const failures = new Map<AppId, Array<typeof UnavailableApp.Type>>();
    const searchFailures = new Map<AppId, Array<typeof UnavailableApp.Type>>();
    const revealed = new Map<AppId, Array<typeof UnavailableApp.Type>>();
    const namespaces: Namespaces = new Map();
    const loadedFrom = new Map<string, VersionId>();
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
    const listed = new Map<string, ReadonlyArray<Entry>>();
    const indexed = new Map<string, ReadonlyArray<SearchTarget>>();
    const call =
      (entry: Entry) =>
      (input: unknown): Effect.Effect<Json, ToolError> =>
        Effect.gen(function* () {
          const recorded = yield* callRecorder(progress);
          return yield* Schema.decodeUnknownEffect(Json)(input).pipe(
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
                  appLinks: {},
                  userLinks: entry.target.linked,
                });
                const result = yield* backend
                  .callTool({
                    app: entry.target.id,
                    accounts,
                    tool: entry.tool.name,
                    kind: entry.tool.readOnly === true ? "query" : "mutation",
                    input,
                  })
                  .pipe(Effect.provideService(ToolCallRecorded, recorded.record));
                if (result.status !== "completed") return yield* approvalRequired(result);
                if (result.toolError === true) yield* toolReportedError(progress);
                return result.value;
              }).pipe(
                Effect.mapError((error) => {
                  const reference = recorded.reference();
                  return toolError(
                    diagnostic(error, site("call")),
                    undefined,
                    reference === undefined ? undefined : { reference },
                  );
                }),
              ),
            ),
          );
        });
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

    const accountsOf = new Map(
      yield* Effect.forEach(apps, (app) =>
        Effect.cached(
          discover("mcp.discovery.accounts", app.id, backend.listAccounts({ app: app.id })).pipe(
            Effect.tapError(unloaded),
          ),
        ).pipe(Effect.map((linked) => [app.id, linked] as const)),
      ),
    );
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
    const searchBatches = new Map<AppId, ReadonlyArray<AppId>>();
    const claimSearchBatch = (selected: ReadonlyArray<{ readonly app: ListedApp }>) =>
      Effect.sync(() => {
        const batch = selected.map(({ app }) => app.id).filter((app) => !searchBatches.has(app));
        for (const app of batch) searchBatches.set(app, batch);
      });
    const searchedApps = yield* Effect.forEach(apps, (app) =>
      Effect.cached(
        discoverApp(app, "mcp.discovery.search", (accounts) =>
          backend.searchableTools(
            { app: app.id, accounts },
            {
              reportRunningAfterMillis: discoveryWaitMs,
              refreshStale: false,
              searchBatch: searchBatches.get(app.id) ?? [app.id],
            },
          ),
        ).pipe(
          Effect.flatMap((result) => projectSearch(app, result)),
          Effect.andThen(reported),
        ),
      ).pipe(Effect.map((load) => ({ app, load }))),
    );
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
    const loadForProgram = (
      selected: ReadonlyArray<{ readonly app: ListedApp; readonly load: Effect.Effect<void> }>,
    ) =>
      Effect.raceFirst(
        Effect.forEach(selected, ({ load }) => load, { concurrency: "unbounded", discard: true }),
        programDeadline.pipe(Effect.andThen(Effect.interrupt)),
      );
    const named = <A extends { readonly app: ListedApp }>(
      all: ReadonlyArray<A>,
      names: ReadonlyArray<string> | "all",
    ) =>
      names === "all" ? all : all.filter(({ app }) => names.some((name) => within(name, app.slug)));
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
    const searchable = (names: ReadonlyArray<string> | "all") =>
      Effect.gen(function* () {
        const selected = named(searchedApps, names);
        yield* claimSearchBatch(selected);
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
      recheck: (error: CodeMode.Diagnostic) => {
        const loaded = loadedWith.get(unknownPath(error)?.split(".")[0] ?? "");
        return loaded === undefined
          ? Effect.void
          : backend
              .listTools({ app: loaded.app, accounts: loaded.accounts, limit: 1 })
              .pipe(
                Effect.timeoutOption(recheckWaitMillis),
                Effect.ignore,
                Effect.withSpan("mcp.execute.recheck"),
              );
      },
    };
  });
}

const recheckWaitMillis = 2_000;

type Namespaces = Map<string, typeof UnavailableApp.Type | "available">;

export type ExecutionProgress = {
  readonly calls: Array<{
    readonly name: string;
    outcome: McpToolCall["outcome"] | "running";
    durationMs?: number;
    toolError?: true;
    reference?: string;
  }>;
  readonly callFibers: Map<number, number>;
  phase: "discovery" | "program";
  unavailableApps: ReadonlyArray<typeof UnavailableApp.Type>;
  readonly failures: Array<Error>;
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
const callRecorder = (progress: ExecutionProgress) =>
  Effect.map(Effect.fiberId, (fiber) => {
    const index = progress.callFibers.get(fiber);
    let reference: string | undefined;
    return {
      record: (recorded: string) => {
        reference = recorded;
        const call = index === undefined ? undefined : progress.calls[index];
        if (call !== undefined) call.reference = recorded;
      },
      reference: () => reference,
    };
  });
export const callLog = (reference: string | undefined): { callLog: CallLog } | {} =>
  reference === undefined ? {} : { callLog: { reference, note: callLogNote } };
const toolReportedError = (progress: ExecutionProgress) =>
  Effect.map(Effect.fiberId, (fiber) => {
    const index = progress.callFibers.get(fiber);
    const call = index === undefined ? undefined : progress.calls[index];
    if (call !== undefined) call.toolError = true;
  });

const unknownPath = (error: CodeMode.Diagnostic) =>
  error.kind === "UnknownTool"
    ? /^(?:Unknown tool(?: namespace)? |Tool )'([^']*)'/.exec(error.message)?.[1]
    : undefined;

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

const unavailableTarget = (error: CodeMode.Diagnostic, namespaces: Namespaces) => {
  const path = unknownPath(error);
  return path === undefined ? undefined : unavailableAt(path, namespaces);
};
const unavailableAt = (path: string, namespaces: Namespaces) => {
  const segments = path.split(".");
  for (let length = segments.length; length > 0; length--) {
    const found = namespaces.get(segments.slice(0, length).join("."));
    if (found === "available") return undefined;
    if (found !== undefined) return found;
  }
  return undefined;
};

const unavailableMessage = (unavailable: typeof UnavailableApp.Type) =>
  unavailable.reason.startsWith("{")
    ? unavailable.reason
    : `${unavailable.name} could not be loaded in this execution (${unavailable.reason}); its tools cannot be called until it loads.`;

export const reportedCalls = (progress: ExecutionProgress): Array<McpToolCall> =>
  progress.calls.flatMap((call) => {
    if (call === undefined) return [];
    const outcome =
      call.outcome === "running"
        ? "interrupted"
        : call.outcome === "success" && call.toolError === true
          ? "failure"
          : call.outcome;
    return [
      {
        name: call.name,
        outcome,
        ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
        ...(call.reference === undefined || outcome === "success"
          ? {}
          : { reference: call.reference }),
      },
    ];
  });

const interruptedSiblingsNote =
  "Other tool calls were still running when the program stopped and were interrupted. toolCalls lists every call with its outcome: calls marked success did run.";

const settleSiblingsAdvice =
  "To keep the results of the calls that succeed when one fails, use Promise.allSettled or a .catch on each call.";

const interruptedNote = (kind: CodeMode.DiagnosticKind) =>
  kind === "ToolFailure"
    ? `${interruptedSiblingsNote} ${settleSiblingsAdvice}`
    : interruptedSiblingsNote;

export const timeoutMessage = (timeoutMs: number, phase: "discovery" | "program") =>
  phase === "discovery"
    ? `Execution timed out after ${timeoutMs}ms while loading app tools; no program code ran.`
    : `Execution timed out after ${timeoutMs}ms; earlier tool calls may have completed.`;

export const timeoutDeliveryMs = 1_000;

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

export type Program = (
  backend: McpBackend<Error>,
  limits: McpLimits,
  deadline: Effect.Effect<void>,
  progress: ExecutionProgress,
) => Effect.Effect<typeof ExecuteResult.Type>;

export const executeProgram =
  (code: string): Program =>
  (backend, limits, deadline, progress) =>
    runProgram(backend, limits, code, deadline, progress);

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
      const tools: McpBackend<Error> = {
        ...backend,
        callTool: (input, options) =>
          backend.callTool(input, options).pipe(Effect.provideService(Clock.Clock, clock)),
      };
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
      const real = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provideService(Clock.Clock, clock));
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
          ...prepared.namespacesOnUse(<A, E>(effect: Effect.Effect<A, E>) => effect),
          ...prepared.tools,
          search,
          "search.describe": describe,
        },
        search: (input) =>
          real(
            globalSearchPage(prepared.searchable, prepared.lost, tools.searchTools, input, () => {
              searchSignatures += 1;
            }),
          ),
        limits: { timeoutMs: limits.timeoutMs, maxToolCalls: limits.maxToolCalls },
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
      const toolCalls = reportedCalls(progress);
      const reported = executionDiagnostic({
        ...result,
        ...(result.ok ? {} : { error: programFailure(result.error) }),
        ...(unknown === undefined || result.ok
          ? {}
          : { error: { ...programFailure(result.error), suggestions: [unknown] } }),
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
        toolCalls,
      });
      const execution =
        reported.ok || timedOut || !toolCalls.some(({ outcome }) => outcome === "interrupted")
          ? reported
          : {
              ...reported,
              error: {
                ...reported.error,
                message: `${reported.error.message} ${interruptedNote(reported.error.kind)}`,
              },
            };
      if (timedOut) yield* Effect.annotateCurrentSpan("executor.timeout.phase", "program");
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

const programFailure = ({ properties, ...error }: CodeMode.Diagnostic) => ({
  ...error,
  ...(error.kind === "ToolFailure" ? callLog(properties?.["reference"]) : {}),
});

const callFailure = (
  path: string,
  kind: CodeMode.DiagnosticKind,
  message: string,
  matches?: ReadonlyArray<string>,
  reference?: string,
): CallOutcome => ({
  path,
  ok: false,
  error: failureDetail({ kind, message }),
  ...(matches === undefined ? {} : { matches }),
  ...callLog(reference),
});

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
                    finish("success").pipe(
                      Effect.as<CallOutcome>({
                        path: name,
                        ok: true,
                        value,
                        ...(progress.calls[index]?.toolError === true
                          ? callLog(progress.calls[index]?.reference)
                          : {}),
                      }),
                    ),
                  onFailure: (error) =>
                    finish("failure").pipe(
                      Effect.as(
                        callFailure(
                          name,
                          "ToolFailure",
                          error.message,
                          undefined,
                          progress.calls[index]?.reference,
                        ),
                      ),
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

const readCatalog = <A>(
  backend: McpBackend<Error>,
  read: (discovered: Effect.Success<ReturnType<typeof catalog>>) => Effect.Effect<A, Error>,
) =>
  Effect.gen(function* () {
    const progress = executionProgress(yield* failureReference);
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

export const searchCatalog = (backend: McpBackend<Error>, input: typeof SearchInput.Type) =>
  readCatalog(backend, (discovered) =>
    searchPage(discovered.searchable, discovered.lost, backend.searchTools, input),
  ).pipe(
    Effect.map(({ value, discovered }) => ({
      ...value,
      unavailableApps: discovered.unavailableApps(),
    })),
  );

export const describeCatalog = (backend: McpBackend<Error>, input: typeof DescribeInput.Type) =>
  readCatalog(backend, (discovered) => describeTools(discovered.described, input.paths)).pipe(
    Effect.map(({ value }) => value),
  );

export const listedTools = (backend: McpBackend<Error>, apps: ReadonlyArray<string> | "all") =>
  readCatalog(backend, (discovered) => discovered.described(apps)).pipe(
    Effect.map(({ value }) => value),
  );
