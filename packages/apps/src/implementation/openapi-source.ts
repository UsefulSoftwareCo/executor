/** Revisioned OpenAPI sources. Calls read a manifest, one operation and only its schema dependencies. */
import { Deferred, Effect, Option, Schema, Duration } from "effect";
import { RouterMeta } from "../contracts/router.ts";
import { parse as parseYamlStrictly } from "yaml";
import { CORE_SCHEMA, load as loadYaml } from "js-yaml";
import type { AppCache, CacheLoadContext } from "../contracts/cache.ts";
import { cacheLimits } from "@executor-js/app-cache/contracts";
import {
  OpenapiOperation,
  OpenapiError,
  isOpenapiReadMethod,
  type OpenapiToolsOptions,
} from "../contracts/openapi.ts";
import { JsonObject, JsonValue } from "../contracts/schema.ts";
import {
  OpenapiCompileError,
  OpenapiSkippedOperation,
  type OpenapiToolNames,
} from "../contracts/openapi-compile.ts";
import type { HostedTool, HostedToolSummary } from "../contracts/host.ts";
import { compileOpenApiDocument } from "./openapi-compile.ts";
import { yieldToRuntime } from "./runtime-yield.ts";
import {
  openapiToolsEffect,
  references,
  bundler,
  prepareOpenapiOperation,
  parameterDefaultsInput,
  type PreparedOpenapiOperation,
} from "./openapi.ts";
import { protocolOperations, type OperationKinds } from "./protocol-operations.ts";
import { routerDeclaration, type RouterDeclaration } from "./router.ts";
import { nativeOperation } from "./operations.ts";
import { wrap } from "./schema.ts";
import { fromPromise, method, toPromise } from "./authoring.ts";
import { createRequest } from "./openapi-request.ts";

/**
 * A published revision and how many parts of each kind it stored. `skipped` holds the declared
 * operations compilation left out, by the name each would have. `meta` describes the document
 * for its router: its info and tag descriptions.
 */
const Manifest = Schema.Struct({
  revision: Schema.String,
  summaries: Schema.Number,
  operations: Schema.Number,
  definitions: Schema.Number,
  skipped: Schema.Number,
  meta: Schema.optionalKey(RouterMeta),
});

/** The fields a tool listing and its account filter read, stored apart from any schema. */
const OperationSummary = Schema.Struct({
  name: OpenapiOperation.fields.name,
  operationId: OpenapiOperation.fields.operationId,
  description: OpenapiOperation.fields.description,
  method: OpenapiOperation.fields.method,
  request: Schema.Struct({ security: OpenapiOperation.fields.request.fields.security }),
  streaming: OpenapiOperation.fields.streaming,
  tags: OpenapiOperation.fields.tags,
});
type OperationSummary = typeof OperationSummary.Type;
const summaryOf = (operation: OpenapiOperation): OperationSummary => ({
  name: operation.name,
  ...(operation.operationId === undefined ? {} : { operationId: operation.operationId }),
  description: operation.description,
  method: operation.method,
  request: { security: operation.request.security },
  ...(operation.streaming === undefined ? {} : { streaming: operation.streaming }),
  ...(operation.tags === undefined ? {} : { tags: operation.tags }),
});
const Summaries = Schema.Array(OperationSummary);
/** Operations or definitions by name. Only the value a caller uses is decoded, and validated. */
const Bucket = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Operations and definitions are stored in buckets of about this many bytes, chosen by a hash of
 * their names. A large API is then a few dozen cache entries rather than one per name, and a call
 * reads only the buckets holding its operation and the definitions it reaches.
 */
const bucketBytes = 64_000;
/** A bucket stays well inside the cache's per-entry bound unless one value alone exceeds it. */
const bucketLimit = 1_500_000;
const summaryPageBytes = 1_000_000;
/** FNV-1a: stable across isolates and releases, as the stored layout requires. */
const bucketOf = (name: string, count: number) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % count;
};
/** Hash buckets of about `bucketBytes`, doubling their count while any exceeds `bucketLimit`. */
const bucketize = (entries: readonly (readonly [string, JsonValue])[]) => {
  const sized = entries.map(
    ([name, value]) => [name, value, JSON.stringify(value).length] as const,
  );
  const total = sized.reduce((sum, [, , bytes]) => sum + bytes, 0);
  for (let count = Math.max(1, Math.ceil(total / bucketBytes)); ; count *= 2) {
    const buckets = Array.from({ length: count }, () => ({
      values: {} as Record<string, JsonValue>,
      size: 0,
      bytes: 0,
    }));
    for (const [name, value, bytes] of sized) {
      const bucket = buckets[bucketOf(name, count)];
      if (bucket === undefined) continue;
      bucket.values[name] = value;
      bucket.size++;
      bucket.bytes += bytes;
    }
    if (
      count >= sized.length ||
      buckets.every((bucket) => bucket.bytes <= bucketLimit || bucket.size === 1)
    )
      return buckets.map((bucket) => bucket.values);
  }
};
/** Consecutive pages of at most `summaryPageBytes`. */
const paginate = <A>(values: readonly A[]) => {
  const pages: A[][] = [[]];
  let bytes = 0;
  for (const value of values) {
    const size = JSON.stringify(value).length;
    const page = pages[pages.length - 1];
    if (page !== undefined && page.length > 0 && bytes + size > summaryPageBytes) {
      pages.push([value]);
      bytes = size;
    } else {
      page?.push(value);
      bytes += size;
    }
  }
  return pages;
};

const DocumentInfo = Schema.Struct({
  info: Schema.optionalKey(
    Schema.Struct({
      title: Schema.optionalKey(Schema.String),
      summary: Schema.optionalKey(Schema.String),
      description: Schema.optionalKey(Schema.String),
    }),
  ),
  tags: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        description: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

/** Router metadata from a document's info and tags. A malformed section is left out. */
const documentMeta = (document: unknown): RouterMeta | undefined => {
  const parsed = Schema.decodeUnknownOption(DocumentInfo)(document);
  if (Option.isNone(parsed)) return undefined;
  const { info, tags } = parsed.value;
  const description = info?.description ?? info?.summary;
  const labels = (tags ?? []).flatMap((tag) =>
    tag.description === undefined ? [] : [[tag.name, tag.description] as const],
  );
  const meta = {
    ...(info?.title === undefined ? {} : { title: info.title }),
    ...(description === undefined ? {} : { description }),
    ...(labels.length === 0 ? {} : { tags: Object.fromEntries(labels) }),
  };
  return Object.keys(meta).length === 0 ? undefined : meta;
};
/**
 * Parts are stored as gzip-compressed JSON text, base64-encoded. The cache and its RPCs carry one
 * short string per part instead of copying and validating a tree of values, and a revision is
 * about a seventh of its JSON size, so even a large API is one or two cache writes.
 */
const partText = wrap(Schema.String, false);
const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};
const gzip = (text: string) =>
  // oxlint-disable-next-line executor/authored-code-through-adapter -- Compression Streams
  Effect.tryPromise({
    try: async () =>
      base64(
        new Uint8Array(
          await new Response(
            new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
          ).arrayBuffer(),
        ),
      ),
    catch: (error) => error,
  });
const gunzip = (stored: string) =>
  // oxlint-disable-next-line executor/authored-code-through-adapter -- Compression Streams
  Effect.tryPromise({
    try: () =>
      new Response(
        new Blob([Uint8Array.from(atob(stored), (char) => char.charCodeAt(0))])
          .stream()
          .pipeThrough(new DecompressionStream("gzip")),
      ).text(),
    catch: invalid,
  });
const decodeText =
  <A>(decoder: Schema.Decoder<A>) =>
  (text: string) =>
    Effect.try({ try: (): unknown => JSON.parse(text), catch: invalid }).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(decoder)(value)),
    );
const schema = <A>(decoder: Schema.Decoder<A>) => wrap(decoder, false);
const invalid = () => new OpenapiError({ reason: "invalid_definition" });

/**
 * Stored revision format. Bump it whenever compilation changes stored operations, such as their
 * names, or the layout of their parts, so a revision cached by an earlier framework is never served.
 */
const format = "openapi-v4";
/** One write command carries as many parts as the cache accepts, with room for its envelope. */
const writeEntries = cacheLimits.batchEntries;
const writeBytes = cacheLimits.batchBytes - 500_000;
/** One read returns at most this many parts, each at most `bucketLimit` bytes. */
const readParts = Math.floor(cacheLimits.batchBytes / bucketLimit);

/** SHA-256 of a value's JSON, as lowercase hex. The JSON text exists only while it is hashed,
 * so a large document is not held twice by the effect that yielded it. */
const sha256Json = (value: JsonValue) =>
  // oxlint-disable-next-line executor/authored-code-through-adapter -- Web Crypto
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
    catch: (error) => error,
  }).pipe(
    Effect.map((hash) =>
      Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
const partConcurrency = 4;

// Immutable, account-free data only. Neither credentials nor executable handlers enter this map.
const resolved = new Map<
  string,
  {
    operation: OpenapiOperation;
    definitions: Readonly<Record<string, JsonObject>>;
    schemas: PreparedOpenapiOperation;
    bytes: number;
  }
>();
let resolvedBytes = 0;
const remember = (
  key: string,
  entry: Omit<NonNullable<ReturnType<typeof resolved.get>>, "bytes">,
) => {
  const bytes = new TextEncoder().encode(
    JSON.stringify([entry.operation, entry.definitions]),
  ).byteLength;
  if (bytes > 8_000_000) return;
  const previous = resolved.get(key);
  if (previous !== undefined) {
    resolvedBytes -= previous.bytes;
    resolved.delete(key);
  }
  while (resolved.size >= 32 || resolvedBytes + bytes > 8_000_000) {
    const oldest = resolved.keys().next().value;
    if (oldest === undefined) break;
    resolvedBytes -= resolved.get(oldest)?.bytes ?? 0;
    resolved.delete(oldest);
  }
  resolved.set(key, { ...entry, bytes });
  resolvedBytes += bytes;
};

// Parts this isolate just stored, by content-addressed revision. They equal the stored values,
// so listing right after a load, or again in the same warm Worker, does not read them back.
const stored = new Map<string, { parts: ReadonlyMap<string, string>; bytes: number }>();
let storedBytes = 0;
const storedPart = (kind: string, name: string | number) => JSON.stringify([kind, name]);
const retain = (revision: string, parts: ReadonlyMap<string, string>, bytes: number) => {
  if (bytes > 8_000_000) return;
  const previous = stored.get(revision);
  if (previous !== undefined) {
    storedBytes -= previous.bytes;
    stored.delete(revision);
  }
  while (stored.size >= 4 || storedBytes + bytes > 8_000_000) {
    const oldest = stored.keys().next().value;
    if (oldest === undefined) break;
    storedBytes -= stored.get(oldest)?.bytes ?? 0;
    stored.delete(oldest);
  }
  stored.set(revision, { parts, bytes });
  storedBytes += bytes;
};

/** Static credential placement and destination are reviewed when the app is authored/imported. */
export interface OpenapiSourceOptions extends Omit<
  OpenapiToolsOptions,
  "operations" | "definitions"
> {
  readonly cache: AppCache;
  readonly source: { readonly url: string } | { readonly document: JsonObject };
  readonly allowedOrigin: string;
  readonly securitySchemes: Readonly<Record<string, JsonObject>>;
  readonly baseUrl?: string;
  /**
   * A path inserted between the server and every operation's path, for a definition that omits a
   * leading segment, such as `/projects/{project}`. Each `{name}` becomes a required string path
   * parameter of every tool, unless the operation already declares it without placing it.
   */
  readonly pathPrefix?: string;
  readonly freshFor?: Duration.Input;
  readonly staleFor?: Duration.Input;
  /**
   * Query or mutation overrides keyed by the document's operationId. An operation without an
   * operationId is keyed by its generated name without the kind, such as `users.getUsers`.
   */
  readonly kinds?: OperationKinds;
  readonly fallbackSecurity?: OpenapiOperation["request"]["security"];
  readonly patches?: readonly {
    readonly op: "add" | "remove" | "replace";
    readonly path: string;
    readonly value?: JsonValue;
  }[];
}

/** JSON-object patches are static app configuration and are reapplied to every revision. */
export function patchOpenapi(
  root: JsonObject,
  patches: OpenapiSourceOptions["patches"],
): JsonObject {
  let result = root;
  for (const patch of patches ?? []) {
    if (!patch.path.startsWith("/")) throw invalid();
    const path = patch.path
      .slice(1)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (path.some((part) => ["__proto__", "constructor", "prototype"].includes(part)))
      throw invalid();
    const update = (node: JsonObject, parts: readonly string[]): JsonObject => {
      const [head, ...rest] = parts;
      if (head === undefined) throw invalid();
      if (rest.length)
        return {
          ...node,
          [head]: update(
            Schema.decodeUnknownSync(JsonObject)(
              Object.hasOwn(node, head) ? node[head] : undefined,
            ),
            rest,
          ),
        };
      if (patch.op !== "add" && !Object.hasOwn(node, head)) throw invalid();
      if (patch.op === "remove")
        return Object.fromEntries(Object.entries(node).filter(([name]) => name !== head));
      if (patch.value === undefined) throw invalid();
      return { ...node, [head]: patch.value };
    };
    result = update(result, path);
  }
  return result;
}

/**
 * How many objects and arrays a value has once its YAML aliases are expanded, and how many distinct
 * ones it has, or undefined when the expansion exceeds `limit`. Each distinct object is sized once,
 * so a small document cannot make this slow.
 */
const expandedNodes = (root: unknown, limit: number) => {
  const sizes = new Map<object, number>();
  const size = (value: unknown): number => {
    if (typeof value !== "object" || value === null) return 0;
    const known = sizes.get(value);
    if (known !== undefined) return known;
    let total = 1;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      total += size(child);
      if (total > limit) break;
    }
    sizes.set(value, total);
    return total;
  };
  const total = size(root);
  return total > limit ? undefined : { total, distinct: sizes.size };
};

/**
 * Read a YAML document as a tree. js-yaml builds values directly; the `yaml` package first builds a
 * node for every scalar, which needs several times the document's size in memory. Aliases are
 * expanded, since compilation needs a tree, when that at most ten-folds the document. A document
 * js-yaml rejects, or whose aliases expand further, is read by the `yaml` package, whose alias
 * limits then apply, so every document it accepted is accepted as before.
 */
const parseYaml = (text: string): unknown => {
  try {
    const value = loadYaml(text, { schema: CORE_SCHEMA, maxAliases: 100 });
    const nodes = expandedNodes(value, 10_000_000);
    if (nodes !== undefined) {
      if (nodes.total === nodes.distinct) return value;
      if (nodes.total <= nodes.distinct * 10 + 100_000) return JSON.parse(JSON.stringify(value));
    }
  } catch {
    // Read by the `yaml` package below.
  }
  return JSON.parse(JSON.stringify(parseYamlStrictly(text)));
};

/** Fetch a bounded document using the loader's owned lifetime, never the original request signal. */
const download = (
  url: string,
  context: Pick<CacheLoadContext, "fetch"> & { readonly signal?: AbortSignal },
) =>
  Effect.gen(function* () {
    // The loader's fetch is the invocation's, which opens its own upstream boundary.
    // oxlint-disable-next-line executor/authored-code-through-adapter -- fetch
    const response = yield* Effect.tryPromise({
      try: () =>
        context.fetch(url, {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          redirect: "manual",
        }),
      catch: (error) => error,
    });
    if (!response.ok || response.body === null) return yield* invalid();
    const reader = response.body.getReader();
    const text = yield* Effect.acquireUseRelease(
      Effect.succeed(reader),
      (reader) =>
        Effect.gen(function* () {
          const decoder = new TextDecoder();
          const chunks: string[] = [];
          let bytes = 0;
          while (true) {
            // oxlint-disable-next-line executor/authored-code-through-adapter -- Streams
            const chunk = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: (error) => error,
            });
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 40_000_000) return yield* invalid();
            chunks.push(decoder.decode(chunk.value, { stream: true }));
          }
          chunks.push(decoder.decode());
          return chunks.join("");
        }),
      (reader) =>
        // oxlint-disable-next-line executor/authored-code-through-adapter -- Streams
        Effect.tryPromise({ try: () => reader.cancel(), catch: (error) => error }).pipe(
          Effect.catch(() => Effect.void),
        ),
    );
    return yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(JsonObject)(
          text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text),
        ),
      catch: invalid,
    });
  });

/** The patched definition, as a tree compilation can own. */
const sourceDocument = (
  options: Pick<OpenapiSourceOptions, "source" | "patches">,
  context: Parameters<typeof download>[1],
) =>
  Effect.gen(function* () {
    return patchOpenapi(
      "url" in options.source
        ? yield* download(options.source.url, context)
        : // A copy the compilation can own, as a tree.
          Schema.decodeUnknownSync(JsonObject)(JSON.parse(JSON.stringify(options.source.document))),
      options.patches,
    );
  });

/** Compile a definition with the source's static settings. */
const compileSource = (options: OpenapiCompileSettings, document: JsonObject) =>
  compileOpenApiDocument(
    { name: "API", ...("url" in options.source ? { connectUrl: options.source.url } : {}) },
    document,
    {
      allowedOrigin: options.allowedOrigin,
      securitySchemes: options.securitySchemes,
      ...(options.fallbackSecurity === undefined
        ? {}
        : { fallbackSecurity: options.fallbackSecurity }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.pathPrefix === undefined ? {} : { pathPrefix: options.pathPrefix }),
    },
  );
type OpenapiCompileSettings = Pick<
  OpenapiSourceOptions,
  "source" | "allowedOrigin" | "securitySchemes" | "fallbackSecurity" | "baseUrl" | "pathPrefix"
>;

/** A tool's kind: `kinds` keyed by operationId, or by name without one, else its method's. */
const operationKind = (
  kinds: OperationKinds | undefined,
  op: {
    readonly name: string;
    readonly operationId?: string;
    readonly method: OpenapiOperation["method"];
  },
) => {
  const key = op.operationId ?? op.name;
  return Object.hasOwn(kinds ?? {}, key)
    ? (kinds?.[key] ?? "mutation")
    : isOpenapiReadMethod(op.method)
      ? "query"
      : "mutation";
};

/** No I/O during app construction. All accounts share credential-free compilation. */
export const liveOpenapiRouter = (options: OpenapiSourceOptions): RouterDeclaration => {
  // Specs change rarely and compiling a large one takes seconds. Idle visits serve the
  // retained revision and refresh it in the background instead of waiting for a full load.
  const freshFor = options.freshFor ?? "5 minutes";
  const staleFor = options.staleFor ?? "1 day";
  const retention =
    Duration.toMillis(Duration.fromInputUnsafe(freshFor)) +
    Duration.toMillis(Duration.fromInputUnsafe(staleFor)) +
    300_000;
  // The key includes every static input to compilation. It never includes account credentials.
  // Large inline documents are hashed once below rather than copied into storage keys.
  const identity = Effect.cached(
    // oxlint-disable-next-line executor/authored-code-through-adapter -- Web Crypto
    Effect.tryPromise({
      try: async () => {
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            source: options.source,
            allowedOrigin: options.allowedOrigin,
            baseUrl: options.baseUrl,
            pathPrefix: options.pathPrefix,
            securitySchemes: options.securitySchemes,
            patches: options.patches,
            fallbackSecurity: options.fallbackSecurity,
          }),
        );
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        );
      },
      catch: invalid,
    }),
  );
  // Each source instance memoizes only the source identity. Persisted data remains revisioned.
  const sourceId = Effect.runSync(identity);
  const pointer = sourceId.pipe(Effect.map((id) => [format, id, "current"]));
  const partKey = (revision: string, kind: string, name: string | number): JsonValue => [
    format,
    revision,
    kind,
    name,
  ];
  // The document belongs to one compilation, which upgrades it in place. It is released when
  // compilation ends, before the compiled parts are serialized and written.
  const compile = (context: CacheLoadContext) =>
    Effect.gen(function* () {
      let document: JsonObject | undefined = yield* sourceDocument(options, context);
      // oxlint-disable-next-line executor/authored-code-through-adapter -- scheduler yield
      yield* Effect.promise(yieldToRuntime);
      // Revisions are content-addressed: refreshing an unchanged document rewrites the
      // same parts and renews their retention instead of storing another copy.
      const revision = yield* sha256Json([format, yield* sourceId, document]);
      const meta = documentMeta(document);
      // This generator's frame lives until compilation ends, so it hands the document over
      // rather than holding it while compilation builds the output.
      const handOver = () => {
        const owned = document;
        document = undefined;
        if (owned === undefined) throw new Error("The document was already handed over.");
        return owned;
      };
      const compiled = yield* compileSource(options, handOver());
      return { revision, meta, compiled };
    });
  // Compiles the document and serializes its parts. Only strings leave it, so the compiled output
  // is released before the parts are written.
  const serialize = (context: CacheLoadContext) =>
    Effect.gen(function* () {
      const { revision, meta, compiled } = yield* compile(context);
      // oxlint-disable-next-line executor/authored-code-through-adapter -- scheduler yield
      yield* Effect.promise(yieldToRuntime);
      const summaries = paginate(compiled.operations.map(summaryOf));
      const operations = bucketize(
        compiled.operations.map((operation) => [operation.name, operation] as const),
      );
      const definitions = bucketize(Object.entries(compiled.definitions));
      const skipped =
        compiled.skipped.length === 0
          ? []
          : bucketize(compiled.skipped.map((operation) => [operation.name, operation] as const));
      const parts: { kind: string; name: number; value: JsonValue }[] = [
        ...summaries.map((value, name) => ({ kind: "summaries", name, value })),
        ...operations.map((value, name) => ({ kind: "operations", name, value })),
        ...definitions.map((value, name) => ({ kind: "definitions", name, value })),
        ...skipped.map((value, name) => ({ kind: "skipped", name, value })),
      ];
      // Each write carries as many parts as one cache command accepts. Publication is last,
      // under the cache loader lease.
      const batches: { entries: { key: JsonValue; value: string }[]; bytes: number }[] = [];
      let batch: { key: JsonValue; value: string }[] = [];
      let size = 0;
      // The retained copy holds each part's exact text; reading it decodes like a cache hit.
      const retained = new Map<string, string>();
      let retainedBytes = 0;
      for (const [index, part] of parts.entries()) {
        // oxlint-disable-next-line executor/authored-code-through-adapter -- scheduler yield
        if (index % 32 === 31) yield* Effect.promise(yieldToRuntime);
        const text = JSON.stringify(part.value);
        const entry = { key: partKey(revision, part.kind, part.name), value: yield* gzip(text) };
        // As the cache measures a command: the escaped text and its key.
        const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
        if (batch.length && (batch.length >= writeEntries || size + bytes > writeBytes)) {
          batches.push({ entries: batch, bytes: size });
          batch = [];
          size = 0;
        }
        batch.push(entry);
        size += bytes;
        retainedBytes += text.length;
        if (retainedBytes <= 8_000_000) retained.set(storedPart(part.kind, part.name), text);
      }
      if (batch.length) batches.push({ entries: batch, bytes: size });
      return {
        manifest: {
          revision,
          summaries: summaries.length,
          operations: operations.length,
          definitions: definitions.length,
          skipped: skipped.length,
          ...(meta === undefined ? {} : { meta }),
        },
        batches,
        retained,
        retainedBytes,
      };
    });
  const refresh = (context: CacheLoadContext) =>
    Effect.gen(function* () {
      const { manifest, batches, retained, retainedBytes } = yield* serialize(context);
      // Revision keys are immutable and independent. Await every write before
      // publishing the manifest, without serializing their network round trips.
      yield* Effect.forEach(
        batches,
        ({ entries, bytes }, index) =>
          fromPromise(method(context.cache, "write"), "cache")(entries, retention).pipe(
            Effect.withSpan("app.cache.flush", {
              attributes: {
                "cache.flush.index": index,
                "cache.flush.count": batches.length,
                "cache.flush.entries": entries.length,
                "cache.flush.bytes": bytes,
              },
            }),
          ),
        {
          concurrency: partConcurrency,
          discard: true,
        },
      );
      retain(manifest.revision, retained, retainedBytes);
      return manifest;
    });
  // A router reads its metadata and its tools together; concurrent reads share one manifest
  // round trip.
  let reading: Deferred.Deferred<typeof Manifest.Type, unknown> | undefined;
  const current = Effect.suspend(() => {
    const shared = reading;
    if (shared !== undefined) return Deferred.await(shared);
    const deferred = Deferred.makeUnsafe<typeof Manifest.Type, unknown>();
    reading = deferred;
    return pointer.pipe(
      Effect.flatMap((key) =>
        fromPromise(
          method(options.cache, "get"),
          "cache",
        )({
          key,
          schema: schema(Manifest),
          freshFor,
          staleFor,
          load: toPromise(refresh, (context: CacheLoadContext) => context.signal),
        }),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (reading === deferred) reading = undefined;
        }).pipe(Effect.andThen(Deferred.done(deferred, exit))),
      ),
    );
  });
  // Parts are read in groups one cache command can return, a few groups at a time.
  const read = <A>(
    revision: string,
    kind: string,
    names: readonly number[],
    decoder: Schema.Decoder<A>,
  ) => {
    const retained = stored.get(revision);
    const decode = decodeText(decoder);
    if (retained !== undefined)
      return Effect.forEach(names, (name) => {
        const text = retained.parts.get(storedPart(kind, name));
        return text === undefined ? Effect.succeed(undefined) : decode(text);
      });
    const groups = Array.from({ length: Math.ceil(names.length / readParts) }, (_, group) =>
      names.slice(group * readParts, (group + 1) * readParts),
    );
    return Effect.forEach(
      groups,
      (group) =>
        fromPromise(method(options.cache, "readMany"), "cache")(
          group.map((name) => partKey(revision, kind, name)),
          partText,
        ).pipe(
          Effect.flatMap((stored) =>
            Effect.forEach(stored, (value) =>
              value === undefined
                ? Effect.succeed(undefined)
                : gunzip(value).pipe(Effect.flatMap(decode)),
            ),
          ),
        ),
      { concurrency: partConcurrency },
    ).pipe(Effect.map((values) => values.flat()));
  };
  const range = (count: number) => Array.from({ length: count }, (_, index) => index);
  const summariesFor = (manifest: typeof Manifest.Type) =>
    Effect.gen(function* () {
      const pages = yield* read(
        manifest.revision,
        "summaries",
        range(manifest.summaries),
        Summaries,
      );
      const summaries: OperationSummary[] = [];
      for (const page of pages) {
        if (page === undefined) return undefined;
        summaries.push(...page);
      }
      return summaries;
    });
  // `undefined` when a stored part is missing; `{ value: undefined }` when no operation has the name.
  const operationFor = (manifest: typeof Manifest.Type, name: string) =>
    Effect.gen(function* () {
      const [bucket] = yield* read(
        manifest.revision,
        "operations",
        [bucketOf(name, manifest.operations)],
        Bucket,
      );
      if (bucket === undefined) return undefined;
      const value = Object.hasOwn(bucket, name) ? bucket[name] : undefined;
      return {
        value:
          value === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(OpenapiOperation)(value),
      };
    });
  /**
   * `undefined` when a stored part is missing and `{ value: undefined }` when compilation did not
   * leave out an operation of that name. A left-out operation fails with why, so reading or calling
   * a tool the definition declares but the importer could not represent explains its absence.
   */
  const leftOutFor = (manifest: typeof Manifest.Type, name: string) =>
    Effect.gen(function* () {
      if (manifest.skipped === 0) return { value: undefined };
      const [bucket] = yield* read(
        manifest.revision,
        "skipped",
        [bucketOf(name, manifest.skipped)],
        Bucket,
      );
      if (bucket === undefined) return undefined;
      const value = Object.hasOwn(bucket, name) ? bucket[name] : undefined;
      if (value === undefined) return { value: undefined };
      const operation = yield* Schema.decodeUnknownEffect(OpenapiSkippedOperation)(value);
      return yield* new OpenapiCompileError({
        code: operation.code,
        reason: operation.reason,
        skipped: [operation],
      });
    });
  // Every operation, in the document's order, which the summaries keep.
  const operationsFor = (manifest: typeof Manifest.Type) =>
    Effect.gen(function* () {
      const summaries = yield* summariesFor(manifest);
      if (summaries === undefined) return undefined;
      const buckets = yield* read(
        manifest.revision,
        "operations",
        range(manifest.operations),
        Bucket,
      );
      const all: OpenapiOperation[] = [];
      for (const { name } of summaries) {
        const bucket = buckets[bucketOf(name, manifest.operations)];
        const value =
          bucket !== undefined && Object.hasOwn(bucket, name) ? bucket[name] : undefined;
        if (value === undefined) return undefined;
        all.push(yield* Schema.decodeUnknownEffect(OpenapiOperation)(value));
      }
      return all;
    });
  // Follows references from `root`, reading each definition bucket once.
  const definitionsFor = (manifest: typeof Manifest.Type, root: JsonValue) =>
    Effect.gen(function* () {
      const definitions: Record<string, JsonObject> = {};
      const buckets = new Map<number, Readonly<Record<string, unknown>>>();
      let pending = [...references(root)];
      while (pending.length) {
        const names = [...new Set(pending)].filter((name) => !Object.hasOwn(definitions, name));
        pending = [];
        const missing = [
          ...new Set(names.map((name) => bucketOf(name, manifest.definitions))),
        ].filter((bucket) => !buckets.has(bucket));
        const values = yield* read(manifest.revision, "definitions", missing, Bucket);
        for (const [index, bucket] of missing.entries()) {
          const value = values[index];
          if (value === undefined) return undefined;
          buckets.set(bucket, value);
        }
        for (const name of names) {
          const bucket = buckets.get(bucketOf(name, manifest.definitions));
          const value =
            bucket !== undefined && Object.hasOwn(bucket, name) ? bucket[name] : undefined;
          if (value === undefined) return undefined;
          const definition = yield* Schema.decodeUnknownEffect(JsonObject)(value);
          definitions[name] = definition;
          pending.push(...references(definition));
        }
      }
      return definitions;
    });
  // Relaxed validators depend only on which parameters are account-bound, never on their values.
  const defaultedNames = JSON.stringify(
    Object.entries(options.parameterDefaults ?? {}).map(([group, values]) => [
      group,
      Object.keys(values ?? {}).sort(),
    ]),
  );
  const kindOf = (op: OperationSummary) => operationKind(options.kinds, op);
  const readOnly = (op: OperationSummary) => kindOf(op) === "query";
  const summarize = (operation: OperationSummary): HostedToolSummary => ({
    name: operation.name,
    description: operation.description,
    readOnly: readOnly(operation),
    ...(operation.tags === undefined ? {} : { tags: operation.tags }),
  });
  const describe = (
    operation: OpenapiOperation,
    bundle: ReturnType<typeof bundler>,
  ): HostedTool => ({
    ...summarize(operation),
    inputSchema: bundle(parameterDefaultsInput(operation, options.parameterDefaults, true)),
    ...(operation.outputSchema === undefined
      ? {}
      : { outputSchema: bundle(operation.outputSchema) }),
  });
  // Repair missing parts once, by reloading the revision.
  const withRevision = <A>(
    work: (manifest: typeof Manifest.Type) => Effect.Effect<{ value: A } | undefined, unknown>,
  ) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = yield* work(yield* current);
        if (result !== undefined) return result.value;
        yield* fromPromise(method(options.cache, "invalidate"), "cache")(yield* pointer);
      }
      return yield* invalid();
    });
  return routerDeclaration({
    kind: "dynamic",
    meta: () => current.pipe(Effect.map((manifest) => manifest.meta ?? {})),
    resolve: (name) =>
      withRevision((manifest) =>
        Effect.gen(function* () {
          const memoKey = `${manifest.revision}/${defaultedNames}/${name}`;
          const memo = resolved.get(memoKey);
          let operation = memo?.operation;
          if (operation === undefined) {
            const found = yield* operationFor(manifest, name);
            if (found === undefined) return undefined;
            if (found.value === undefined) return yield* leftOutFor(manifest, name);
            operation = found.value;
          }
          const definitions = memo?.definitions ?? (yield* definitionsFor(manifest, operation));
          if (definitions === undefined) return undefined;
          const schemas =
            memo?.schemas ??
            (yield* prepareOpenapiOperation(operation, definitions, options.parameterDefaults));
          if (memo === undefined) remember(memoKey, { operation, definitions, schemas });
          const tools = yield* openapiToolsEffect(
            { ...options, operations: [operation], definitions },
            new Map([[operation.name, schemas]]),
          );
          const declarations = protocolOperations(tools, {
            [operation.name]: kindOf(operation),
          });
          const declaration = Object.hasOwn(declarations, name) ? declarations[name] : undefined;
          return { value: declaration === undefined ? undefined : nativeOperation(declaration) };
        }),
      ),
    list: () =>
      withRevision((manifest) =>
        Effect.gen(function* () {
          const all = yield* operationsFor(manifest);
          if (all === undefined) return undefined;
          const definitions = yield* definitionsFor(manifest, all);
          if (definitions === undefined) return undefined;
          const bundle = bundler(definitions);
          const request = createRequest(options);
          return {
            value: all
              .filter((op) => request.available(op, options.account))
              .map((operation) => describe(operation, bundle)),
          };
        }),
      ),
    summaries: () =>
      withRevision((manifest) =>
        Effect.gen(function* () {
          const all = yield* summariesFor(manifest);
          if (all === undefined) return undefined;
          const request = createRequest(options);
          return {
            value: all
              .filter((op) => request.available(op, options.account))
              .map((operation) => summarize(operation)),
          };
        }),
      ),
    describe: (name) =>
      withRevision((manifest) =>
        Effect.gen(function* () {
          const found = yield* operationFor(manifest, name);
          if (found === undefined) return undefined;
          if (found.value === undefined) return yield* leftOutFor(manifest, name);
          const operation = found.value;
          if (!createRequest(options).available(operation, options.account))
            return { value: undefined };
          const definitions = yield* definitionsFor(manifest, operation);
          if (definitions === undefined) return undefined;
          return { value: describe(operation, bundler(definitions)) };
        }),
      ),
  });
};

/** The settings `openapiToolNames` reads: the router's, without an account or cache. */
export type OpenapiToolNamesOptions = Omit<
  OpenapiSourceOptions,
  "cache" | "account" | "parameterDefaults" | "freshFor" | "staleFor"
>;

/**
 * The tools `liveOpenapiRouter` with the same options exposes, from the definition alone: no
 * account, cache or deployment. Each tool says which `methods` and `oauth` entries expose it, so
 * an author can check the names a `withApprovals` policy matches before any account connects.
 * `skipped` lists only the operations the compiler left out and why. An operation no configured
 * `methods` or `oauth` entry can authorize is missing from `tools` and not listed in `skipped`.
 * `fetch` defaults to the global fetch.
 */
export const openapiToolNames = (options: OpenapiToolNamesOptions): Promise<OpenapiToolNames> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const document = yield* sourceDocument(options, {
        fetch: options.fetch ?? globalThis.fetch,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const compiled = yield* compileSource(options, document);
      const request = createRequest(options);
      // An account of each method with every field it binds, so availability depends only on
      // the operation's security, never on credential values.
      const accounts = [
        ...Object.entries(options.methods).map(([method, bindings]) => ({
          method,
          fields: Object.fromEntries(bindings.map(({ field }) => [field, "placeholder"])),
        })),
        ...options.oauth.map((method) => ({ method, fields: { access_token: "placeholder" } })),
      ];
      const tools = compiled.operations.flatMap((op) => {
        const methods = accounts
          .filter((account) => request.available(op, account))
          .map((account) => account.method);
        const anonymous = request.available(op, undefined);
        return methods.length === 0 && !anonymous
          ? []
          : [
              {
                name: op.name,
                method: op.method,
                path: op.path,
                ...(op.operationId === undefined ? {} : { operationId: op.operationId }),
                kind: operationKind(options.kinds, op),
                public: anonymous,
                methods,
              },
            ];
      });
      return { tools, skipped: compiled.skipped };
    }),
    options.signal === undefined ? {} : { signal: options.signal },
  );
