/** Revisioned OpenAPI sources. Calls read a manifest, one operation and only its schema dependencies. */
import { Effect, Schema, Duration } from "effect";
import { parse } from "yaml";
import type { AppCache, CacheLoadContext } from "../contracts/cache.ts";
import { OpenapiOperation, OpenapiError, type OpenapiToolsOptions } from "../contracts/openapi.ts";
import { JsonObject, type JsonValue } from "../contracts/schema.ts";
import type { DynamicTools } from "../contracts/dynamic-tools.ts";
import type { HostedTool, HostedToolSummary } from "../contracts/host.ts";
import { compileOpenApiDocument } from "./openapi-compile.ts";
import {
  openapiToolsEffect,
  references,
  bundler,
  prepareOpenapiOperation,
  parameterDefaultsInput,
  type PreparedOpenapiOperation,
} from "./openapi.ts";
import { protocolOperations, type OperationKinds } from "./protocol-operations.ts";
import { nativeOperation } from "./operations.ts";
import { wrap } from "./schema.ts";
import { fromPromise, toPromise } from "./authoring.ts";
import { createRequest } from "./openapi-request.ts";

const Manifest = Schema.Struct({ revision: Schema.String, pages: Schema.Number });
const Names = Schema.Array(Schema.String);
const schema = <A>(decoder: Schema.Decoder<A>) => wrap(decoder, false);
const invoke = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error });
const invalid = () => new OpenapiError({ reason: "invalid_definition" });

const pageSize = 64;

/** SHA-256 of a string, as lowercase hex. */
const sha256 = (text: string) =>
  invoke(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
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
  readonly freshFor?: Duration.Input;
  readonly staleFor?: Duration.Input;
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

/** Fetch a bounded document using the loader's owned lifetime, never the original request signal. */
const download = (url: string, context: CacheLoadContext) =>
  Effect.gen(function* () {
    const response = yield* invoke(() =>
      context.fetch(url, { signal: context.signal, redirect: "manual" }),
    );
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
            const chunk = yield* invoke(() => reader.read());
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 40_000_000) return yield* invalid();
            chunks.push(decoder.decode(chunk.value, { stream: true }));
          }
          chunks.push(decoder.decode());
          return chunks.join("");
        }),
      (reader) => invoke(() => reader.cancel()).pipe(Effect.catch(() => Effect.void)),
    );
    return yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(JsonObject)(
          text.trimStart().startsWith("{") ? JSON.parse(text) : parse(text),
        ),
      catch: invalid,
    });
  });

/** No I/O during app construction. All accounts share credential-free compilation. */
export const liveOpenapiOperations = (
  options: OpenapiSourceOptions,
): {
  readonly queries: {};
  readonly mutations: {};
  readonly dynamicTools: DynamicTools;
} => {
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
    Effect.tryPromise({
      try: async () => {
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            source: options.source,
            allowedOrigin: options.allowedOrigin,
            baseUrl: options.baseUrl,
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
  const pointer = sourceId.pipe(Effect.map((id) => ["openapi-v1", id, "current"]));
  const partKey = (revision: string, kind: string, name: string | number): JsonValue => [
    "openapi-v1",
    revision,
    kind,
    name,
  ];
  const refresh = (context: CacheLoadContext) =>
    Effect.gen(function* () {
      const raw =
        "url" in options.source
          ? yield* download(options.source.url, context)
          : options.source.document;
      const document = patchOpenapi(raw, options.patches);
      const compiled = yield* compileOpenApiDocument(
        { name: "API", ...("url" in options.source ? { connectUrl: options.source.url } : {}) },
        document,
        {
          allowedOrigin: options.allowedOrigin,
          securitySchemes: options.securitySchemes,
          ...(options.fallbackSecurity === undefined
            ? {}
            : { fallbackSecurity: options.fallbackSecurity }),
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        },
      );
      // Revisions are content-addressed: refreshing an unchanged document rewrites the
      // same parts and renews their retention instead of storing another copy.
      const revision = yield* sha256(JSON.stringify([yield* sourceId, document]));
      const names = compiled.operations.map((operation) => operation.name);
      const entries: { key: JsonValue; value: JsonValue }[] = [
        ...compiled.operations.map((operation) => ({
          key: partKey(revision, "operation", operation.name),
          value: operation,
        })),
        ...Object.entries(compiled.definitions).map(([name, value]) => ({
          key: partKey(revision, "definition", name),
          value,
        })),
      ];
      const pages = Math.ceil(names.length / pageSize);
      for (let page = 0; page < pages; page++)
        entries.push({
          key: partKey(revision, "names", page),
          value: names.slice(page * pageSize, (page + 1) * pageSize),
        });
      // Byte and count bounds apply to each RPC. Publication is last, under the cache loader lease.
      const batches: (typeof entries)[] = [];
      let batch: typeof entries = [];
      let size = 0;
      for (const entry of entries) {
        const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
        if (batch.length && (batch.length >= 64 || size + bytes > 4_000_000)) {
          batches.push(batch);
          batch = [];
          size = 0;
        }
        batch.push(entry);
        size += bytes;
      }
      if (batch.length) batches.push(batch);
      // Revision keys are immutable and independent. Await every write before
      // publishing the manifest, without serializing their network round trips.
      yield* Effect.forEach(
        batches,
        (entries) => fromPromise(context.cache.write)(entries, retention),
        {
          concurrency: partConcurrency,
          discard: true,
        },
      );
      return { revision, pages };
    });
  const current = Effect.gen(function* () {
    const key = yield* pointer;
    return yield* fromPromise(options.cache.get)({
      key,
      schema: schema(Manifest),
      freshFor,
      staleFor,
      load: toPromise(refresh),
    });
  });
  const read = <A>(
    revision: string,
    kind: string,
    names: readonly (string | number)[],
    decoder: Schema.Decoder<A>,
  ) =>
    fromPromise(options.cache.readMany)(
      names.map((name) => partKey(revision, kind, name)),
      schema(decoder),
    );
  const namesFor = (manifest: typeof Manifest.Type) =>
    Effect.gen(function* () {
      const names: string[] = [];
      for (let page = 0; page < manifest.pages; page += pageSize) {
        const pages = yield* read(
          manifest.revision,
          "names",
          Array.from({ length: Math.min(pageSize, manifest.pages - page) }, (_, i) => page + i),
          Names,
        );
        for (const values of pages) {
          if (values === undefined) return undefined;
          names.push(...values);
        }
      }
      return names;
    });
  const definitionsFor = (revision: string, operation: JsonValue) =>
    Effect.gen(function* () {
      const definitions: Record<string, JsonObject> = {};
      const seen = new Set<string>();
      let pending = [...references(operation)];
      while (pending.length) {
        const names = [...new Set(pending.splice(0, pageSize * partConcurrency))].filter(
          (name) => !seen.has(name),
        );
        names.forEach((name) => seen.add(name));
        if (!names.length) continue;
        const values = (yield* Effect.forEach(
          Array.from({ length: Math.ceil(names.length / pageSize) }, (_, page) =>
            names.slice(page * pageSize, (page + 1) * pageSize),
          ),
          (batch) => read(revision, "definition", batch, JsonObject),
          { concurrency: partConcurrency },
        )).flat();
        for (let i = 0; i < names.length; i++) {
          const name = names[i];
          const value = values[i];
          if (name === undefined || value === undefined) return undefined;
          definitions[name] = value;
          pending.push(...references(value));
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
  const qualified = (op: OpenapiOperation) =>
    `${(options.kinds?.[op.name] ?? (["GET", "HEAD", "OPTIONS"].includes(op.method) ? "query" : "mutation")) === "query" ? "queries" : "mutations"}.${op.name}`;
  const operationsFor = (manifest: typeof Manifest.Type) =>
    Effect.gen(function* () {
      const names = yield* namesFor(manifest);
      if (names === undefined) return undefined;
      const pages = yield* Effect.forEach(
        Array.from({ length: Math.ceil(names.length / pageSize) }, (_, page) =>
          names.slice(page * pageSize, (page + 1) * pageSize),
        ),
        (batch) => read(manifest.revision, "operation", batch, OpenapiOperation),
        { concurrency: partConcurrency },
      );
      const all: OpenapiOperation[] = [];
      for (const operations of pages) {
        for (const operation of operations) {
          if (operation === undefined) return undefined;
          all.push(operation);
        }
      }
      return all;
    });
  const summarize = (operation: OpenapiOperation): HostedToolSummary => {
    const name = qualified(operation);
    return { name, description: operation.description, readOnly: name.startsWith("queries.") };
  };
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
  // Repair missing parts once. A missing operation is checked against the revision's name index.
  const withRevision = <A>(
    work: (manifest: typeof Manifest.Type) => Effect.Effect<{ value: A } | undefined, unknown>,
  ) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = yield* work(yield* current);
        if (result !== undefined) return result.value;
        yield* fromPromise(options.cache.invalidate)(yield* pointer);
      }
      return yield* invalid();
    });
  return {
    queries: {},
    mutations: {},
    dynamicTools: {
      resolve: (name) =>
        withRevision((manifest) =>
          Effect.gen(function* () {
            const raw = name.replace(/^(queries|mutations)\./, "");
            const memoKey = `${manifest.revision}/${defaultedNames}/${raw}`;
            const memo = resolved.get(memoKey);
            const operation =
              memo?.operation ??
              (yield* read(manifest.revision, "operation", [raw], OpenapiOperation))[0];
            if (operation === undefined) {
              const names = yield* namesFor(manifest);
              return names === undefined || names.includes(raw) ? undefined : { value: undefined };
            }
            if (qualified(operation) !== name) return { value: undefined };
            const definitions =
              memo?.definitions ?? (yield* definitionsFor(manifest.revision, operation));
            if (definitions === undefined) return undefined;
            const schemas =
              memo?.schemas ??
              (yield* prepareOpenapiOperation(operation, definitions, options.parameterDefaults));
            if (memo === undefined) remember(memoKey, { operation, definitions, schemas });
            const tools = yield* openapiToolsEffect(
              { ...options, operations: [operation], definitions },
              new Map([[operation.name, schemas]]),
            );
            const declarations = protocolOperations(tools, options.kinds);
            const declaration = declarations.queries[raw] ?? declarations.mutations[raw];
            return { value: declaration === undefined ? undefined : nativeOperation(declaration) };
          }),
        ),
      list: () =>
        withRevision((manifest) =>
          Effect.gen(function* () {
            const all = yield* operationsFor(manifest);
            if (all === undefined) return undefined;
            const definitions = yield* definitionsFor(manifest.revision, all);
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
            const all = yield* operationsFor(manifest);
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
            const raw = name.replace(/^(queries|mutations)\./, "");
            const operation = (yield* read(
              manifest.revision,
              "operation",
              [raw],
              OpenapiOperation,
            ))[0];
            if (operation === undefined) {
              const names = yield* namesFor(manifest);
              return names === undefined || names.includes(raw) ? undefined : { value: undefined };
            }
            if (
              qualified(operation) !== name ||
              !createRequest(options).available(operation, options.account)
            )
              return { value: undefined };
            const definitions = yield* definitionsFor(manifest.revision, operation);
            if (definitions === undefined) return undefined;
            return { value: describe(operation, bundler(definitions)) };
          }),
        ),
    },
  };
};
