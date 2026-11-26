import { BlobKey, BlobStore, BlobStoreError } from "../contracts/blobs.ts";
import { RuntimeBuildFailed, RuntimeBuildUnavailable } from "../contracts/runtime.ts";
import type { BuildId } from "../contracts/shared.ts";
import type { UiBuildFile } from "../contracts/ui-build.ts";
import type { RuntimeAsset } from "../contracts/runtime.ts";
import { asciiJson } from "./ascii-json.ts";
import { publicFileAsset, readPublicManifest } from "./public-files.ts";
import { Effect, Option, Schedule, Schema } from "effect";
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

export const storageFailure = (error: unknown): error is BlobStoreError =>
  Schema.is(BlobStoreError)(error) &&
  (error.status === undefined || error.status === 429 || error.status >= 500);

export const key = (value: string) => Schema.decodeUnknownEffect(BlobKey)(value);
export const frameworkKey = ({ version, sha256 }: FrameworkIdentity) =>
  key(`frameworks/${version}-${sha256}.json`);
export const buildKey = (build: BuildId) => key(`${build}/worker.json`);
export const inlinedBuildKey = (build: BuildId) => key(`${build}.json`);

export const encodeJson = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S["Type"]) =>
  Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.map((text) => new TextEncoder().encode(asciiJson(text))),
  );
export const decodeJson = <S extends Schema.Codec<unknown, unknown>>(schema: S, body: Uint8Array) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(body));

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

export const assembleWorkerBundle = (
  bundle: WorkerBundle,
  framework: Pick<WorkerFramework, "modules">,
): WorkerBundle => ({
  mainModule: bundle.mainModule,
  modules: { ...bundle.modules, ...framework.modules },
});

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
    if (!stored)
      yield* blobs.put(location, yield* encodeJson(RetainedFramework, retained)).pipe(
        Effect.catchIf(storageFailure, (refused) =>
          blobs.exists(location).pipe(
            Effect.orElseSucceed(() => false),
            Effect.flatMap((found) => (found ? Effect.void : Effect.fail(refused))),
            Effect.retry({ times: 3, schedule: Schedule.exponential("1 second") }),
            Effect.tap(() =>
              Effect.annotateCurrentSpan("executor.build.framework_stored_by", "another"),
            ),
          ),
        ),
      );
    return retained;
  });

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
    Effect.mapError((error) =>
      storageFailure(error) ? error : new RuntimeBuildFailed({ stage: "retain" }),
    ),
    Effect.withSpan("runtime.cloud.retain"),
  );

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

export const loadWorkerBuild = (build: BuildId) =>
  loadStoredWorkerBuild(build).pipe(
    Effect.flatMap((stored) => linkWorkerBuild(stored, loadWorkerFramework)),
  );

export const workerBuildAsset = (build: BuildId, path: string) =>
  Effect.gen(function* () {
    const assetKey = Schema.decodeUnknownOption(BlobKey)(`${build}/ui/${path}`);
    if (Option.isNone(assetKey)) return undefined;
    const blobs = yield* BlobStore;
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
