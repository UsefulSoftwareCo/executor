/**
 * Retained builds store each `apps` framework release once. A build's record holds its own modules
 * and the identity of the framework it links; loading a build reads both and links them.
 */
import { BlobKey, BlobStore } from "../contracts/blobs.ts";
import { RuntimeBuildFailed, RuntimeBuildUnavailable } from "../contracts/runtime.ts";
import type { BuildId } from "../contracts/shared.ts";
import type { UiBuildFile } from "../contracts/ui-build.ts";
import type { RuntimeAsset } from "../contracts/runtime.ts";
import { asciiJson } from "./ascii-json.ts";
import { publicFileAsset, readPublicManifest } from "./public-files.ts";
import { Effect, Option, Schema } from "effect";
import {
  type FrameworkIdentity,
  InlinedWorkerBuild,
  type LoadedWorkerBuild,
  RetainedFramework,
  RetainedWorkerBuild,
  type StoredWorkerBuild,
  type WorkerBundle,
  type WorkerFramework,
} from "../contracts/worker-build.ts";

/** Shared with the one-off framework migration, which reads and writes the same objects. */
export const key = (value: string) => Schema.decodeUnknownEffect(BlobKey)(value);
/** The release's label leads for operators; the hash alone decides which object a build links. */
export const frameworkKey = ({ version, sha256 }: FrameworkIdentity) =>
  key(`frameworks/${version}-${sha256}.json`);
export const buildKey = (build: BuildId) => key(`${build}/worker.json`);
/** Where builds with an inlined framework live. Removed with `InlinedWorkerBuild`. */
export const inlinedBuildKey = (build: BuildId) => key(`${build}.json`);

/** Written in ASCII, so a large record decodes to one-byte strings; see `asciiJson`. */
export const encodeJson = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S["Type"]) =>
  Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.map((text) => new TextEncoder().encode(asciiJson(text))),
  );
export const decodeJson = <S extends Schema.Codec<unknown, unknown>>(schema: S, body: Uint8Array) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(body));

/** The SHA-256 of a framework's server modules, by name, independent of their stored encoding. */
export const frameworkIdentity = (framework: WorkerFramework) =>
  Effect.promise(async () => {
    const canonical = JSON.stringify(
      Object.keys(framework.modules)
        .sort()
        .map((name) => [name, framework.modules[name]]),
    );
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return { version: framework.version, sha256 } satisfies FrameworkIdentity;
  });

/** The complete Worker code: the app's modules with the framework's linked beside them. */
export const assembleWorkerBundle = (
  bundle: WorkerBundle,
  framework: Pick<WorkerFramework, "modules">,
): WorkerBundle => ({
  mainModule: bundle.mainModule,
  modules: { ...bundle.modules, ...framework.modules },
});

/**
 * Store the framework once at its content address. Concurrent deploys of the same release write
 * identical content, and each put publishes a complete object, so a lost race is harmless.
 */
const retainFramework = (framework: WorkerFramework) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const identity = yield* frameworkIdentity(framework);
    const location = yield* frameworkKey(identity);
    const stored = yield* blobs.exists(location);
    yield* Effect.annotateCurrentSpan({
      "executor.build.framework": `${identity.version}-${identity.sha256}`,
      "executor.build.framework_stored": stored,
    });
    const retained: RetainedFramework = { ...identity, modules: framework.modules };
    if (!stored) yield* blobs.put(location, yield* encodeJson(RetainedFramework, retained));
    return retained;
  });

/**
 * A successful return makes the framework, the server code and every listed UI object available.
 * The build record is written last, so a failed publication yields no build reference. Returns
 * the stored record and framework, so a host can warm its caches without reading them back.
 */
export const retainWorkerBuild = (
  build: BuildId,
  bundle: WorkerBundle & Pick<RetainedWorkerBuild, "database" | "protocol">,
  framework: WorkerFramework,
  ui: readonly UiBuildFile[] | undefined,
) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const retained = yield* retainFramework(framework);
    const identity: FrameworkIdentity = { version: retained.version, sha256: retained.sha256 };
    if (ui !== undefined)
      yield* Effect.forEach(
        ui,
        (file) =>
          Effect.gen(function* () {
            yield* blobs.put(yield* key(`${build}/ui/${file.path}`), file.body);
          }),
        { concurrency: 8, discard: true },
      );
    const metadata = ui?.map(({ path, contentType }) => ({ path, contentType }));
    const record: RetainedWorkerBuild = {
      format: 2,
      mainModule: bundle.mainModule,
      modules: bundle.modules,
      framework: identity,
      database: bundle.database,
      protocol: bundle.protocol,
      ...(metadata === undefined ? {} : { ui: metadata }),
    };
    const body = yield* encodeJson(RetainedWorkerBuild, record);
    yield* Effect.annotateCurrentSpan({
      "executor.build.retained_bytes": body.byteLength,
      "executor.build.module_count": Object.keys(bundle.modules).length,
    });
    yield* blobs.put(yield* buildKey(build), body);
    return { record, framework: retained };
  }).pipe(
    Effect.mapError(() => new RuntimeBuildFailed({ stage: "retain" })),
    Effect.withSpan("runtime.cloud.retain"),
  );

/**
 * A build's stored record: its own modules, UI manifest and framework identity. Until the
 * migration finishes, a build without a record may still be stored with its framework inlined.
 */
export const loadStoredWorkerBuild = (build: BuildId) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const found = yield* blobs.get(yield* buildKey(build));
    if (Option.isSome(found)) return yield* decodeJson(RetainedWorkerBuild, found.value);
    const inlined = yield* blobs.get(yield* inlinedBuildKey(build));
    if (Option.isNone(inlined)) return yield* new RuntimeBuildUnavailable();
    return yield* decodeJson(InlinedWorkerBuild, inlined.value);
  }).pipe(
    Effect.map((stored): StoredWorkerBuild => stored),
    Effect.tap((stored) => Effect.annotateCurrentSpan("executor.build.format", stored.format)),
    Effect.mapError(() => new RuntimeBuildUnavailable()),
    Effect.withSpan("runtime.build.record"),
  );

/** One stored framework. A record names only frameworks written before it, so absence is a fault. */
export const loadWorkerFramework = (identity: FrameworkIdentity) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const found = yield* blobs.get(yield* frameworkKey(identity));
    if (Option.isNone(found)) return yield* new RuntimeBuildUnavailable();
    const framework = yield* decodeJson(RetainedFramework, found.value);
    if (framework.sha256 !== identity.sha256) return yield* new RuntimeBuildUnavailable();
    return framework;
  }).pipe(
    Effect.mapError(() => new RuntimeBuildUnavailable()),
    Effect.withSpan("runtime.build.framework", {
      attributes: { "executor.build.framework": `${identity.version}-${identity.sha256}` },
    }),
  );

/** Link a stored record with its framework, read through the caller's own loader. */
export const linkWorkerBuild = <E, R>(
  stored: StoredWorkerBuild,
  framework: (identity: FrameworkIdentity) => Effect.Effect<RetainedFramework, E, R>,
): Effect.Effect<LoadedWorkerBuild, E, R> =>
  stored.format === 1
    ? Effect.succeed({
        mainModule: stored.mainModule,
        modules: stored.modules,
        protocol: stored.protocol,
      })
    : framework(stored.framework).pipe(
        Effect.map((linked) => ({
          ...assembleWorkerBundle(stored, linked),
          protocol: stored.protocol,
        })),
      );

/** The complete code a runner cold-starts: the build's record linked with its framework. */
export const loadWorkerBuild = (build: BuildId) =>
  loadStoredWorkerBuild(build).pipe(
    Effect.flatMap((stored) => linkWorkerBuild(stored, loadWorkerFramework)),
  );

/** The product authenticates access; this capability serves only assets listed in the immutable build. */
export const workerBuildAsset = (build: BuildId, path: string) =>
  Effect.gen(function* () {
    const assetKey = Schema.decodeUnknownOption(BlobKey)(`${build}/ui/${path}`);
    if (Option.isNone(assetKey)) return undefined;
    const blobs = yield* BlobStore;
    // Both immutable objects can load together. The manifest still authorizes
    // the exact asset before any bytes leave this capability.
    const { retained, found } = yield* Effect.all(
      {
        retained: loadStoredWorkerBuild(build).pipe(
          Effect.withSpan("runtime.cloud.asset.manifest"),
        ),
        found: blobs.get(assetKey.value).pipe(Effect.withSpan("runtime.cloud.asset.object")),
      },
      { concurrency: 2 },
    );
    const asset = retained.ui?.find((asset) => asset.path === path);
    if (asset !== undefined) {
      if (Option.isNone(found)) return yield* new RuntimeBuildUnavailable();
      return { body: found.value, contentType: asset.contentType } satisfies RuntimeAsset;
    }
    // Public files stay in the lineage's store; the build's listing names the ones it serves.
    const manifest = yield* readPublicManifest(blobs, build).pipe(
      Effect.withSpan("runtime.cloud.asset.public"),
    );
    if (Option.isNone(manifest)) return undefined;
    const entry = manifest.value.files.find((file) => file.path === path);
    return entry === undefined ? undefined : publicFileAsset(blobs, manifest.value.code, entry);
  }).pipe(
    Effect.mapError(() => new RuntimeBuildUnavailable()),
    Effect.withSpan("runtime.cloud.asset"),
  );
