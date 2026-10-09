/** Build a live catalog and execute code against configured apps. */
import { CodeMode, Namespace, Tool, toolError } from "@opencode-ai/codemode";
import { tokTypes, tokenizer, type Token } from "acorn";
import {
  Json,
  AppSlug,
  JsonObject,
  routerFailure,
  ToolApprovalRequired,
  ToolListingTimedOut,
  type App,
  type AppId,
  type Cursor,
  type DeploymentId,
  type Tool as AppTool,
  type ToolRouter,
} from "@executor-js/sdk/core";
import { Clock, Deferred, Duration, Effect, JsonPointer, Option, Schema, Semaphore } from "effect";
import { diagnostic, executionDiagnostic } from "./diagnostics.ts";
import type { McpTarget } from "../contracts/targets.ts";
import type { McpBackend } from "../contracts/backend.ts";
import {
  AppDiscoveryTimedOut,
  AppProfileRequired,
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

// Codemode treats dots as namespace separators. Leave ordinary names readable;
// only escape characters needed to distinguish inaccessible/reserved segments.
function toolPath(name: string): string {
  return name
    .split(".")
    .map((segment) => {
      if (segment === "") return "%00";
      if (["__proto__", "prototype", "constructor"].includes(segment)) return `%${segment}`;
      return segment.replaceAll("%", "%25");
    })
    .join(".");
}

function listTools<E extends Error>(
  backend: McpBackend<E>,
  app: AppId,
  target: McpTarget,
  /** Records each page as progress. */
  paged: Effect.Effect<void>,
  /** Discovery's wait bound: a listing another request started longer ago is reported at once. */
  waitMs: number,
) {
  return Effect.gen(function* () {
    const tools: AppTool[] = [];
    let routers: readonly ToolRouter[] = [];
    let cursor: Cursor | undefined;
    let deployment: DeploymentId | undefined;
    const selection =
      target.kind === "app" ? {} : { profile: target.id, expectedProfileRevision: target.revision };
    do {
      const page = yield* backend.listTools(
        { app, ...selection, deployment, cursor, limit: 2_000 },
        { reportRunningAfterMillis: waitMs },
      );
      yield* paged;
      deployment = page.deployment;
      tools.push(...page.items);
      routers = page.routers;
      cursor = page.next;
    } while (cursor !== undefined);
    return { tools, routers, deployment, selection };
  });
}

/**
 * Projections of kept tool listings. The SDK serves every page of a kept listing from the same
 * item objects, so a projection keyed by those objects lives exactly as long as the listing and
 * is not recomputed while the listing is reused. A listing evaluated again has new objects, and
 * nothing here outlives the listing it was derived from.
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

/**
 * A loaded target: an app's own tools, or one of its profiles. Search results list each target
 * once instead of labelling every tool with it.
 */
type Target = {
  readonly slug: string;
  /** Canonical path below `tools`: the slug, or `slug.profiles.<id>`. */
  readonly path: string;
  readonly app: string;
  readonly profile?: string;
  readonly accounts?: string;
  /** The target's routers by router path. The root router has path "". */
  readonly routers: ReadonlyMap<string, ToolRouter>;
};
/** One callable tool of a loaded target. */
type Entry = {
  /** Canonical path below `tools`. */
  readonly path: string;
  readonly tool: AppTool;
  readonly schemas: RenderedSchemas;
  /** The program's own tool at this path. */
  readonly program: Tool.Tool;
  readonly target: Target;
};
/** A search candidate: one tool, and the same tool under the app's other profiles. */
type Candidate = { readonly entry: Entry; readonly others: ReadonlyArray<Entry> };

/** What makes two profiles' tools the same tool for search: name aside, everything agents read. */
const identities = new WeakMap<AppTool, string>();
const identity = (tool: AppTool) => {
  const known = identities.get(tool);
  if (known !== undefined) return known;
  const computed = JSON.stringify([
    tool.description,
    tool.router ?? null,
    tool.inputSchema,
    tool.outputSchema ?? null,
  ]);
  identities.set(tool, computed);
  return computed;
};

/**
 * Merge each tool that several of an app's targets expose with the same signature into one
 * candidate at its first path. `entries` are in path order.
 */
const candidates = (entries: ReadonlyArray<Entry>): ReadonlyArray<Candidate> => {
  const named = new Map<string, Array<Entry>>();
  for (const entry of entries) {
    const key = `${entry.target.slug}\u0000${entry.tool.name}`;
    const known = named.get(key);
    if (known === undefined) named.set(key, [entry]);
    else known.push(entry);
  }
  const others = new Map<Entry, Array<Entry>>();
  const merged = new Set<Entry>();
  for (const group of named.values()) {
    if (group.length < 2) continue;
    const first = new Map<string, Entry>();
    for (const entry of group) {
      const kept = first.get(identity(entry.tool));
      if (kept === undefined) {
        first.set(identity(entry.tool), entry);
        continue;
      }
      merged.add(entry);
      const known = others.get(kept);
      if (known === undefined) others.set(kept, [entry]);
      else known.push(entry);
    }
  }
  return entries.flatMap((entry) =>
    merged.has(entry) ? [] : [{ entry, others: others.get(entry) ?? [] }],
  );
};

/** Text CodeMode's search matches for every tool below a namespace. */
const labels = (...parts: ReadonlyArray<string | undefined>) =>
  parts.filter((part): part is string => part !== undefined && part !== "").join(" ");

/**
 * The names and descriptions of a tool's top-level input properties, after a top-level reference:
 * the input text CodeMode's search matches.
 */
const inputLabels = new WeakMap<AppTool, string>();
const inputLabel = (entry: Entry) => {
  const known = inputLabels.get(entry.tool);
  if (known !== undefined) return known;
  const { input } = entry.schemas;
  const reference = input.$ref?.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1];
  const properties =
    input.$ref === undefined
      ? input.properties
      : reference === undefined
        ? undefined
        : { ...input.definitions, ...input.$defs }[JsonPointer.unescapeToken(reference)]
            ?.properties;
  const computed = labels(
    ...Object.entries(properties ?? {}).flatMap(([name, property]) => [
      name,
      typeof property.description === "string" ? property.description : undefined,
    ]),
  );
  inputLabels.set(entry.tool, computed);
  return computed;
};
/** A stand-in that CodeMode ranks by its description, without rendering a signature. */
const rankingStubs = new WeakMap<AppTool, Tool.Tool>();
const rankingStub = (entry: Entry) => {
  const known = rankingStubs.get(entry.tool);
  if (known !== undefined) return known;
  const stub = Tool.make({
    description: entry.tool.description,
    input: { type: "object" },
    execute: () => Effect.void,
  });
  rankingStubs.set(entry.tool, stub);
  return stub;
};

/**
 * The tool tree CodeMode ranks: every candidate at its own path, with its other text as namespace
 * descriptions, which CodeMode's search matches for each tool below them: the app's name, the
 * profile's label and accounts, router titles, and on each tool's own node its input labels and a
 * merged tool's other profiles. CodeMode matches input labels and namespace descriptions with the
 * same weight, so the stand-ins rank as the tools would without rendering their signatures.
 */
const rankingTree = (ranked: ReadonlyArray<Candidate>) => {
  const tree: Record<string, Tool.Tool | Namespace.Namespace> = Object.create(null);
  const apps = new Map<string, { names: Array<string>; namespaces: Map<string, Array<string>> }>();
  const seen = new Set<Target>();
  for (const { entry, others } of ranked) {
    const { target } = entry;
    const app = apps.get(target.slug) ?? { names: [target.app], namespaces: new Map() };
    apps.set(target.slug, app);
    // Namespaces are relative to the app's own namespace.
    const note = (path: string, text: string) => {
      if (text === "") return;
      const key = path.slice(target.slug.length + 1);
      app.namespaces.set(key, [...(app.namespaces.get(key) ?? []), text]);
    };
    if (!seen.has(target)) {
      seen.add(target);
      const root = target.routers.get("");
      const own = labels(target.profile, target.accounts, root?.title, root?.description);
      if (target.path === target.slug) app.names.push(own);
      else note(target.path, own);
      for (const [path, router] of target.routers)
        if (path !== "")
          note(`${target.path}.${toolPath(path)}`, labels(router.title, router.description));
    }
    note(
      entry.path,
      labels(
        inputLabel(entry),
        ...others.flatMap((other) => [other.target.profile, other.target.accounts]),
      ),
    );
    tree[entry.path] = rankingStub(entry);
  }
  // Each app's namespace and its tools' paths below it meet in one CodeMode node per segment.
  for (const [slug, app] of apps) {
    const name = labels(...app.names);
    tree[slug] = Namespace.make({
      ...(name === "" ? {} : { description: name }),
      tools: Object.fromEntries(
        [...app.namespaces].map(([path, texts]) => [
          path,
          Namespace.make({ description: labels(...texts), tools: {} }),
        ]),
      ),
    });
  }
  return tree;
};

const RankedPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String })),
  remaining: Schema.Int,
});
type RankRequest = { readonly query: string; readonly offset: number; readonly limit: number };
/** CodeMode's search over one set of candidates, as the paths it ranks for a request. */
type Ranking = (
  request: RankRequest,
) => Effect.Effect<{ readonly paths: ReadonlyArray<string>; readonly remaining: number }>;
/**
 * Rank candidates with CodeMode's own `search()`, the same ranking a program's global `search()`
 * uses. The pinned CodeMode exports no ranking function, so a one-line program calls it. The
 * ranking holds only listing data, never an execution's own objects.
 */
const ranking = (ranked: ReadonlyArray<Candidate>): Ranking => {
  const runtime = ranked.length === 0 ? undefined : CodeMode.make({ tools: rankingTree(ranked) });
  return (request) =>
    Effect.gen(function* () {
      if (runtime === undefined) return { paths: [], remaining: 0 };
      const result = yield* runtime.execute(`return search(${JSON.stringify(request)});`);
      if (!result.ok) return yield* Effect.die(result.error.message);
      const page = yield* Schema.decodeUnknownEffect(RankedPage)(result.value).pipe(Effect.orDie);
      return { paths: page.items.map((item) => item.path), remaining: page.remaining };
    });
};
/** Everything a ranking depends on: each candidate's path and listed tool, and every label. */
const rankingBasis = (ranked: ReadonlyArray<Candidate>) => {
  const basis: Array<unknown> = [];
  const seen = new Set<Target>();
  for (const { entry, others } of ranked) {
    basis.push(entry.path, entry.tool, others.length);
    for (const other of others) basis.push(other.target.profile, other.target.accounts);
    if (seen.has(entry.target)) continue;
    seen.add(entry.target);
    basis.push(entry.target.app, entry.target.profile, entry.target.accounts);
    for (const router of entry.target.routers.values())
      basis.push(router.path, router.title, router.description);
  }
  return basis;
};
/**
 * Rankings reused across executions. A kept tool listing serves the same tool objects, so a
 * ranking is kept by its first candidate's tool, reused while its basis is unchanged, and goes
 * when the listing does. Each tool keeps the last few, for the namespaces searched below it.
 */
const keptRankings = new WeakMap<
  AppTool,
  ReadonlyArray<{ readonly basis: ReadonlyArray<unknown>; readonly ranking: Ranking }>
>();
const rankingFor = (ranked: ReadonlyArray<Candidate>) => {
  const anchor = ranked[0]?.entry.tool;
  if (anchor === undefined) return ranking(ranked);
  const basis = rankingBasis(ranked);
  const kept = keptRankings.get(anchor) ?? [];
  const same = kept.find(
    (item) =>
      item.basis.length === basis.length &&
      item.basis.every((value, index) => value === basis[index]),
  );
  if (same !== undefined) return same.ranking;
  const made = ranking(ranked);
  keptRankings.set(anchor, [{ basis, ranking: made }, ...kept].slice(0, 4));
  return made;
};
/** Ranks this execution's candidates and returns them in rank order. */
const ranker = (ranked: ReadonlyArray<Candidate>) => {
  const rank = rankingFor(ranked);
  const byPath = new Map(
    ranked.map((candidate) => [CodeMode.toolExpression(candidate.entry.path), candidate]),
  );
  return (request: RankRequest) =>
    rank(request).pipe(
      Effect.map(({ paths, remaining }) => ({
        items: paths.flatMap((path) => {
          const candidate = byPath.get(path);
          return candidate === undefined ? [] : [candidate];
        }),
        remaining,
      })),
    );
};
type Ranker = ReturnType<typeof ranker>;

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
const inputTypes = new WeakMap<AppTool, string>();
const inputType = (entry: Entry) =>
  Effect.gen(function* () {
    const known = inputTypes.get(entry.tool);
    if (known !== undefined) return known;
    const rendered = yield* signatureOf(entry.schemas.input, undefined);
    const prefix = "(input: ";
    const suffix = "): Promise<void>";
    const computed =
      rendered === "(): Promise<void>"
        ? "{}"
        : rendered.startsWith(prefix) && rendered.endsWith(suffix)
          ? singleLine(rendered.slice(prefix.length, -suffix.length))
          : yield* Effect.die(`Unexpected CodeMode input signature: ${rendered.slice(0, 80)}`);
    inputTypes.set(entry.tool, computed);
    return computed;
  });
/** A tool's whole signature, `(input: ...): Promise<...>`, with its documentation. */
const signatures = new WeakMap<AppTool, string>();
const signature = (entry: Entry) =>
  Effect.gen(function* () {
    const known = signatures.get(entry.tool);
    if (known !== undefined) return known;
    const computed = yield* signatureOf(entry.schemas.input, entry.schemas.output ?? Schema.Json);
    signatures.set(entry.tool, computed);
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

/** A target's namespace, as results list it once. */
const targetNamespace = (target: Target): SearchNamespace => ({
  path: CodeMode.toolExpression(target.path),
  app: target.app,
  ...(target.profile === undefined ? {} : { profile: target.profile }),
  ...(target.accounts === undefined ? {} : { accounts: target.accounts }),
});
/** The namespaces an entry's path sits in: its target, and its router when that has a title. */
const namespacesOf = (entry: Entry): ReadonlyArray<SearchNamespace> => {
  const { target } = entry;
  const router =
    entry.tool.router === undefined ? undefined : target.routers.get(entry.tool.router);
  return [
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
};
const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

/** One `.name` or `["name"]` member of a tool expression. */
const expressionMember =
  /^(?:\.([A-Za-z_$][\w$]*)|\[("(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\])/;
/**
 * The canonical path of a name an agent passes: a tool expression such as
 * `tools.acme.profiles["ins_1"].issues` becomes `acme.profiles.ins_1.issues`, and `tools` alone
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
type Searchable<E> = (
  names: ReadonlyArray<string> | "all",
) => Effect.Effect<ReadonlyArray<Entry>, E>;

/**
 * One page of ranked tools. Items are added in rank order until the next would take the page past
 * its byte budget, so a page never exceeds the execute output limit; it always holds at least one
 * match. `remaining` and `next` count from the last item the page holds. A namespace's apps load
 * once per execution, so its ranker is kept in `rankers` for the execution's later searches.
 */
const searchPage = <E>(
  searchable: Searchable<E>,
  rankers: Map<string, Ranker>,
  limits: McpLimits,
  input: typeof SearchInput.Type,
) =>
  Effect.gen(function* () {
    const namespace = input.namespace === undefined ? "" : canonical(input.namespace);
    const offset = input.offset ?? 0;
    const entries = yield* searchable(namespace === "" ? "all" : [namespace]);
    const rank =
      rankers.get(namespace) ??
      ranker(
        candidates(
          namespace === "" ? entries : entries.filter((entry) => within(entry.path, namespace)),
        ),
      );
    rankers.set(namespace, rank);
    const ranked = yield* rank({
      query: input.query ?? "",
      offset,
      limit: input.limit ?? defaultSearchLimits.defaultItems,
    });
    const budget = searchPageBytes(limits);
    let used = jsonBytes({ items: [], namespaces: [], remaining: 0, next: { ...input, offset } });
    const items: Array<typeof SearchItem.Type> = [];
    const namespaces = new Map<string, SearchNamespace>();
    for (const { entry, others } of ranked.items) {
      const type = yield* inputType(entry);
      const item = {
        path: CodeMode.toolExpression(entry.path),
        description: summary(entry.tool),
        input: cut(type, defaultSearchLimits.inputChars),
        ...(type.length > defaultSearchLimits.inputChars ? { inputTruncated: true as const } : {}),
        ...(others.length === 0
          ? {}
          : { alsoAt: others.map((other) => CodeMode.toolExpression(other.path)) }),
      };
      const added = new Map<string, SearchNamespace>();
      for (const space of [
        ...namespacesOf(entry),
        ...others.map((other) => targetNamespace(other.target)),
      ])
        if (!namespaces.has(space.path)) added.set(space.path, space);
      const cost =
        jsonBytes(item) +
        1 +
        [...added.values()].reduce((sum, space) => sum + jsonBytes(space) + 1, 0);
      if (items.length > 0 && used + cost > budget) break;
      used += cost;
      items.push(item);
      for (const [path, space] of added) namespaces.set(path, space);
    }
    const remaining = ranked.remaining + ranked.items.length - items.length;
    return {
      items,
      namespaces: [...namespaces.values()],
      remaining,
      next: remaining > 0 ? { ...input, offset: offset + items.length } : null,
    };
  });

/**
 * Full detail for exact tool paths. A path that names no tool is reported with the closest paths
 * in its app, ranked as search ranks them.
 */
const describeTools = <E>(searchable: Searchable<E>, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const named = paths.map(canonical);
    const entries = yield* searchable(named.filter((path) => path !== ""));
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const items: Array<(typeof DescribeResult.Type.items)[number]> = [];
    const namespaces = new Map<string, SearchNamespace>();
    const missing: Array<(typeof DescribeResult.Type.missing)[number]> = [];
    for (const [index, path] of paths.entries()) {
      const name = named[index] ?? "";
      const entry = byPath.get(name);
      if (entry === undefined) {
        const closest = yield* ranker(
          entries
            .filter((candidate) => within(name, candidate.target.slug))
            .map((candidate) => ({ entry: candidate, others: [] })),
        )({ query: name, offset: 0, limit: 3 });
        missing.push({
          path,
          matches: closest.items.map((candidate) => CodeMode.toolExpression(candidate.entry.path)),
        });
        continue;
      }
      items.push({
        path: CodeMode.toolExpression(entry.path),
        description: entry.tool.description,
        signature: yield* signature(entry),
      });
      for (const space of namespacesOf(entry)) namespaces.set(space.path, space);
    }
    return { items, namespaces: [...namespaces.values()], missing };
  });

/**
 * The apps a program can reach. Every tool path starts at the `tools` global, so a program whose
 * uses of `tools` are all static members, such as `tools.github` or `tools["my-app"]`, reaches
 * only those apps. Any other use (`tools[name]`, `Object.keys(tools)`, passing `tools` around)
 * and CodeMode's global `search()`, which reads the program's own tool index, reach every app.
 * Source that does not tokenize also reaches every app; CodeMode then reports its parse error.
 */
export const programReach = (code: string) =>
  Effect.try({
    try: () =>
      // Acorn's declarations omit the token value it sets: cooked identifier and string text.
      Array.from(
        tokenizer(code, {
          ecmaVersion: "latest",
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
        }),
        (token: Token & { readonly value?: unknown }) => ({
          type: token.type,
          value: typeof token.value === "string" ? token.value : undefined,
        }),
      ),
    catch: () => "all" as const,
  }).pipe(
    Effect.map((tokens): ReadonlySet<string> | "all" => {
      const at = (index: number) => tokens[index] ?? { type: tokTypes.eof, value: undefined };
      const member = (index: number) =>
        at(index).type === tokTypes.dot || at(index).type === tokTypes.questionDot;
      const slugs = new Set<string>();
      for (const [index, token] of tokens.entries()) {
        if (token.type !== tokTypes.name || member(index - 1)) continue;
        if (token.value === "search") return "all";
        if (token.value !== "tools") continue;
        // tools.slug and tools?.slug; property names may be keywords.
        const name = at(index + 2);
        if (
          member(index + 1) &&
          name.value !== undefined &&
          (name.type === tokTypes.name || name.type.keyword !== undefined)
        ) {
          slugs.add(name.value);
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
          slugs.add(key.value);
          continue;
        }
        return "all";
      }
      return slugs;
    }),
    Effect.orElseSucceed(() => "all" as const),
  );

type ListedApp = Pick<App, "id" | "name" | "slug">;

/**
 * Discover apps on demand within one execution. Listing apps is cheap; listing an app's targets
 * and tools can mean evaluating thousands of definitions or reaching an upstream server, so each
 * app is discovered at most once and only when the program or its search needs it. The backend
 * may serve a tool listing it kept from an earlier execution; its rendered schemas and search
 * projections are then reused too. Everything else is per execution.
 */
function catalog(backend: McpBackend<Error>, progress: ExecutionProgress) {
  return Effect.gen(function* () {
    const {
      discoveryConcurrency: concurrency,
      discoveryWaitMs,
      discoveryIdleMs,
    } = defaultMcpRuntimeLimits;
    const slots = yield* Semaphore.make(concurrency);
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
      }).pipe(Effect.withSpan(name));
    const apps = yield* backend.listApps().pipe(Effect.withSpan("mcp.discovery.apps"));
    yield* Effect.annotateCurrentSpan({
      "executor.discovery.apps": apps.length,
      "executor.discovery.concurrency": concurrency,
    });
    const counts = new Map<string, number>();
    for (const app of apps) counts.set(app.slug, (counts.get(app.slug) ?? 0) + 1);
    const unique = (app: ListedApp) => Schema.is(AppSlug)(app.slug) && counts.get(app.slug) === 1;
    const tools: Catalog = Object.create(null);
    const failures = new Map<AppId, Array<typeof UnavailableApp.Type>>();
    // Tool path prefixes that expose no tools in this execution, and those that do. A call is
    // attributed to the longest matching prefix, so a typo inside a loaded namespace stays unknown.
    const namespaces: Namespaces = new Map();
    /** The deployment each loaded namespace's tools came from. */
    const loadedFrom = new Map<string, DeploymentId>();
    const unavailableApps = () => apps.flatMap((app) => failures.get(app.id) ?? []);
    /**
     * Report an app that exposes no tools, such as one that needs a profile, once a search or
     * describe names it; otherwise its empty result would look like an app with no tools. A call
     * already reports why in its error, and unnamed apps stay quiet: most members never set up
     * most of their organization's account apps.
     */
    const reveal = (entry: typeof UnavailableApp.Type) =>
      Effect.sync(() => {
        const app = apps.find((candidate) => candidate.id === entry.app);
        const failed = app === undefined ? undefined : failures.get(app.id);
        if (failed === undefined || failed.includes(entry)) return;
        failed.push(entry);
        progress.unavailableApps = unavailableApps();
      });
    /** Each loaded app's callable tools, for search. */
    const listed = new Map<string, ReadonlyArray<Entry>>();

    const discoverApp = (app: ListedApp) =>
      Effect.gen(function* () {
        if (!unique(app))
          return {
            targets: [],
            error: !Schema.is(AppSlug)(app.slug) ? "AppSlugInvalid" : "AppSlugAmbiguous",
          };
        return yield* discover(
          "mcp.discovery.targets",
          app.id,
          backend.listTargets({ app: app.id }),
        ).pipe(
          Effect.flatMap((targets) =>
            Effect.forEach(
              targets,
              (target) =>
                discover(
                  "mcp.discovery.tools",
                  app.id,
                  listTools(backend, app.id, target, settled, discoveryWaitMs),
                ).pipe(
                  Effect.map((catalog) => ({ target, catalog, error: undefined })),
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      // This app's listing has run for longer than discovery waits, or recently
                      // timed out. Give up on the app now, as discovery would after waiting,
                      // rather than wait for its other listings again.
                      if (Schema.is(ToolListingTimedOut)(error)) yield* stop(app.id);
                      yield* unloaded(error);
                      return { target, catalog: undefined, error: diagnostic(error) };
                    }),
                  ),
                ),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map((targets) => ({ targets, error: undefined })),
          Effect.catch((error) =>
            unloaded(error).pipe(Effect.as({ targets: [], error: diagnostic(error) })),
          ),
        );
      });

    const project = (
      app: ListedApp,
      { targets, error }: Effect.Success<ReturnType<typeof discoverApp>>,
    ) =>
      Effect.gen(function* () {
        const failed: Array<typeof UnavailableApp.Type> = [];
        failures.set(app.id, failed);
        if (error !== undefined) {
          const entry = { app: app.id, name: app.name, reason: error };
          failed.push(entry);
          if (unique(app)) namespaces.set(app.slug, entry);
          return;
        }
        // An app that needs accounts exposes no target when the caller has no enabled profile.
        // A call into it fails with that reason, and a search or describe that names it lists it
        // (see `reveal`). Unnamed, it stays quiet: most members never set up most of their
        // organization's account apps.
        if (targets.length === 0) {
          namespaces.set(app.slug, {
            app: app.id,
            name: app.name,
            reason: diagnostic(new AppProfileRequired({ app: app.id })),
          });
          tools[app.slug] = {};
          return;
        }
        const entries: Array<readonly [string, Tool.Tool]> = [];
        const found: Array<Entry> = [];
        for (const { target, catalog, error } of targets) {
          const namespace =
            target.kind === "app" ? app.slug : `${app.slug}.profiles.${toolPath(target.id)}`;
          if (catalog === undefined) {
            const entry = {
              app: app.id,
              name: app.name,
              ...(target.kind === "profile" ? { profile: target.id } : {}),
              reason: error,
            };
            failed.push(entry);
            namespaces.set(namespace, entry);
            continue;
          }
          namespaces.set(namespace, "available");
          if (catalog.deployment !== undefined) loadedFrom.set(namespace, catalog.deployment);
          // A router that could not list its tools is reported like an app, at its own namespace,
          // so a call into it explains why instead of reporting an unknown tool.
          const groups = new Map(catalog.routers.map((router) => [router.path, router]));
          for (const router of catalog.routers) {
            if (router.error === undefined) continue;
            const entry = {
              app: app.id,
              name: `${app.name} ${router.title ?? router.path}`,
              ...(target.kind === "profile" ? { profile: target.id } : {}),
              router: router.path,
              reason: diagnostic(
                routerFailure({ app: app.id, deployment: catalog.deployment }, router.error),
              ),
            };
            failed.push(entry);
            namespaces.set(`${namespace}.${toolPath(router.path)}`, entry);
          }
          const described: Target = {
            slug: app.slug,
            path: namespace,
            app: app.name,
            ...(target.kind === "app"
              ? {}
              : {
                  profile: target.label,
                  ...(target.accounts === undefined ? {} : { accounts: target.accounts }),
                }),
            routers: groups,
          };
          const projected = yield* Effect.forEach(catalog.tools, (tool) =>
            renderSchemas(tool).pipe(
              Effect.map((schemas) => {
                const name =
                  target.kind === "app"
                    ? toolPath(tool.name)
                    : `profiles.${toolPath(target.id)}.${toolPath(tool.name)}`;
                const program = Tool.make({
                  description: tool.description,
                  input: schemas.input,
                  output: schemas.output ?? Schema.Json,
                  execute: (input) =>
                    Schema.decodeUnknownEffect(Json)(input).pipe(
                      Effect.mapError(() => toolError("Tool arguments must be JSON")),
                      Effect.flatMap((input) =>
                        backend
                          .callTool({
                            app: app.id,
                            deployment: catalog.deployment,
                            ...catalog.selection,
                            tool: tool.name,
                            kind: tool.readOnly === true ? "query" : "mutation",
                            input,
                          })
                          .pipe(
                            Effect.flatMap((result) =>
                              result.status === "completed"
                                ? Effect.succeed(result.value)
                                : Effect.fail(
                                    new ToolApprovalRequired({
                                      app: result.invocation.app,
                                      deployment: result.invocation.deployment,
                                      tool: result.invocation.tool,
                                    }),
                                  ),
                            ),
                            Effect.mapError((error) => toolError(diagnostic(error))),
                          ),
                      ),
                    ),
                });
                found.push({
                  path: `${app.slug}.${name}`,
                  tool,
                  schemas,
                  program,
                  target: described,
                });
                return [name, program] as const;
              }),
            ),
          );
          entries.push(...projected);
        }
        // An app none of whose targets loaded is unavailable as a whole.
        const whole = failed[0];
        if (entries.length === 0 && whole !== undefined && !namespaces.has(app.slug))
          namespaces.set(app.slug, whole);
        tools[app.slug] = Object.fromEntries(entries);
        listed.set(app.slug, found);
      });

    // Each app is discovered at most once, by whichever of the program or a search needs it first.
    const discovered = yield* Effect.forEach(apps, (app) =>
      Effect.cached(
        discoverApp(app).pipe(
          Effect.flatMap((result) => project(app, result)),
          Effect.andThen(
            Effect.sync(() => {
              progress.unavailableApps = unavailableApps();
            }),
          ),
        ),
      ).pipe(Effect.map((load) => ({ app, load }))),
    );
    /**
     * Wait for the selected apps. After `discoveryWaitMs`, once no listing has completed for
     * `discoveryIdleMs`, give up on every selected app still running a listing, however many
     * there are. Apps still queued then start, with a new idle period.
     */
    const load = (selected: ReadonlyArray<(typeof discovered)[number]>) =>
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

    /**
     * The tools of every app the canonical names lie in, once those apps are loaded. A name is an
     * app slug, a target or router below it, or a tool path. Entries are in path order.
     */
    const searchable = (names: ReadonlyArray<string> | "all") =>
      Effect.gen(function* () {
        const selected =
          names === "all"
            ? discovered
            : discovered.filter(({ app }) => names.some((name) => within(name, app.slug)));
        yield* load(selected);
        if (names !== "all")
          for (const { app } of selected) {
            const entry = namespaces.get(app.slug);
            if (unique(app) && entry !== undefined && entry !== "available") yield* reveal(entry);
          }
        const entries = selected
          .flatMap(({ app }) => (unique(app) ? (listed.get(app.slug) ?? []) : []))
          .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
        // Like the program's catalog, the size this search's CPU grows with.
        yield* Effect.annotateCurrentSpan({
          "executor.discovery.apps": selected.length,
          "executor.discovery.tools": entries.length,
        });
        return entries;
      }).pipe(Effect.withSpan("mcp.search.discovery"));
    const reachable = (reach: ReadonlySet<string> | "all") =>
      reach === "all" ? discovered : discovered.filter(({ app }) => reach.has(app.slug));
    const slugs = new Set(apps.map((app) => app.slug));
    return {
      tools,
      namespaces,
      load,
      reachable,
      searchable,
      unavailableApps,
      unknownTool: (error: CodeMode.Diagnostic) => unknownTool(error, loadedFrom, slugs),
    };
  });
}

/** Unavailable namespaces map to their reason; loaded ones are marked available. */
type Namespaces = Map<string, typeof UnavailableApp.Type | "available">;

/** What one execution has done so far, so a result assembled by its driver stays accurate. */
export type ExecutionProgress = {
  /** Calls admitted by the program, updated as each call starts and ends. */
  readonly calls: Array<{
    readonly name: string;
    outcome: McpToolCall["outcome"] | "running";
    durationMs?: number;
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
};
export const executionProgress = (): ExecutionProgress => ({
  calls: [],
  callFibers: new Map(),
  phase: "discovery",
  unavailableApps: [],
  failures: [],
});
const recordFailure = (progress: ExecutionProgress, error: Error) =>
  Effect.sync(() => {
    progress.failures.push(error);
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
  loadedFrom: ReadonlyMap<string, DeploymentId>,
  slugs: ReadonlySet<string>,
) => {
  const path = unknownPath(error);
  if (path === undefined) return undefined;
  const segments = path.split(".");
  const slug = segments[0] ?? "";
  for (let length = segments.length; length > 0; length--) {
    const deployment = loadedFrom.get(segments.slice(0, length).join("."));
    if (deployment !== undefined)
      return `This execute loaded '${slug}' from deployment ${deployment} when it first reached the app. If the app was deployed after that, call its new tools in a new execute. Otherwise use search to find the app's tools.`;
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
  if (path === undefined) return undefined;
  const segments = path.split(".");
  for (let length = segments.length; length > 0; length--) {
    const found = namespaces.get(segments.slice(0, length).join("."));
    if (found === "available") return undefined;
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * A snapshot for a result. A call still running when the execution ends is reported as
 * interrupted. A driver-assembled result lists only calls whose start was recorded.
 */
export const reportedCalls = (progress: ExecutionProgress): Array<McpToolCall> =>
  progress.calls.flatMap((call) =>
    call === undefined
      ? []
      : [
          {
            name: call.name,
            outcome: call.outcome === "running" ? "interrupted" : call.outcome,
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
 * Internal interpreter entry. `deadline` completes when the execution's budget is spent; the
 * caller decides whether that is wall time or active time. Discovery stops at the deadline;
 * a running program is stopped by CodeMode so its admitted calls and logs are returned.
 */
export function executeProgram(
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
      // Discovery covers the apps the program can reach; search discovers others when it runs.
      const reach = yield* programReach(code);
      const loaded = yield* Effect.gen(function* () {
        const discovered = yield* catalog(tools, progress);
        const reachable = discovered.reachable(reach);
        yield* Effect.annotateCurrentSpan("executor.discovery.reachable", reachable.length);
        yield* discovered.load(reachable);
        yield* Effect.annotateCurrentSpan({
          "executor.discovery.tools": Object.values(discovered.tools).reduce(
            (sum, entries) => sum + Object.keys(entries).length,
            0,
          ),
          "executor.discovery.unavailable": progress.unavailableApps.length,
        });
        return discovered;
      }).pipe(
        Effect.withSpan("mcp.catalog"),
        Effect.map(Option.some),
        Effect.raceFirst(deadline.pipe(Effect.as(Option.none()))),
      );
      if (Option.isNone(loaded)) {
        yield* Effect.annotateCurrentSpan("executor.timeout.phase", "discovery");
        return failure("TimeoutExceeded", timeoutMessage(limits.timeoutMs, "discovery"));
      }
      const prepared = loaded.value;
      progress.phase = "program";
      // Discovery for a search runs on the real clock, like tool calls.
      const rankers = new Map<string, Ranker>();
      const search = Tool.make({
        description:
          "Find app tools by words in their paths, descriptions and labels. Returns exact callable paths, one-line descriptions and input types, with each app and profile listed once. Use tools.search.describe for output types and whole descriptions.",
        input: SearchInput,
        output: SearchResult,
        execute: (input) =>
          searchPage(prepared.searchable, rankers, limits, input).pipe(
            Effect.provideService(Clock.Clock, clock),
          ),
      });
      const describe = Tool.make({
        description:
          "Read the whole description and TypeScript signature, with input and output types, of tools at exact paths from tools.search.",
        input: DescribeInput,
        output: DescribeResult,
        execute: ({ paths }) =>
          describeTools(prepared.searchable, paths).pipe(Effect.provideService(Clock.Clock, clock)),
      });
      const runtime = CodeMode.make({
        tools: { ...prepared.tools, search, "search.describe": describe },
        limits,
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
                message: unavailable.reason.startsWith("{")
                  ? unavailable.reason
                  : `${unavailable.name} could not be loaded in this execution (${unavailable.reason}); its tools cannot be called until it loads.`,
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
      // Signatures cost CPU per reachable tool; a program renders them only by searching.
      yield* Effect.annotateCurrentSpan(
        "executor.codemode.signatures_rendered",
        runtime.signaturesRendered(),
      );
      yield* Effect.annotateCurrentSpan("executor.outcome", execution.ok ? "completed" : "failed");
      return { execution, unavailableApps: prepared.unavailableApps() };
    }).pipe(
      Effect.catch((error) =>
        recordFailure(progress, error).pipe(
          Effect.as(failure("ExecutionFailure", diagnostic(error))),
        ),
      ),
    );
  });
}
