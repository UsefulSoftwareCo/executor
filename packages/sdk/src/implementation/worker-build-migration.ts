/**
 * One-off migration of builds retained with their `apps` framework inlined in `<build>.json` to a
 * record, `<build>/worker.json`, that links a framework stored once. See
 * notes/build-framework-migration.md. `<build>.json` is never deleted or rewritten, so code that
 * predates the split can still load every build that existed before it.
 *
 * This module owns its own copy of the inlined schema: it is migration code, and stays after the
 * runtime reader of inlined builds is removed.
 */
import { sourceText } from "../contracts/source.ts";
import { Effect, Option, Schema } from "effect";
import { type BlobKey, BlobStore } from "../contracts/blobs.ts";
import { UiAsset } from "../contracts/runtime.ts";
import type { BuildId, DeploymentId } from "../contracts/shared.ts";
import {
  AppProtocolVersion,
  type FrameworkIdentity,
  type LoadedWorkerBuild,
  RetainedFramework,
  RetainedWorkerBuild,
  WorkerBundle,
} from "../contracts/worker-build.ts";
import { readDeploymentSource } from "./deployment-source.ts";
import {
  buildKey,
  decodeJson,
  encodeJson,
  frameworkIdentity,
  frameworkKey,
  inlinedBuildKey,
  linkWorkerBuild,
  loadStoredWorkerBuild,
  loadWorkerBuild,
  loadWorkerFramework,
} from "./worker-build-storage.ts";

/** A build as every host retained it before frameworks were stored once. */
const InlinedBuild = Schema.Struct({
  ...WorkerBundle.fields,
  database: Schema.Boolean,
  ui: Schema.optional(Schema.Array(UiAsset)),
  /** Builds retained before protocols were recorded speak protocol 1, the only one then. */
  protocol: AppProtocolVersion.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
});
type InlinedBuild = typeof InlinedBuild.Type;

/**
 * The published `apps` releases, by the SHA-256 of their `runtime.json` server modules as
 * `frameworkIdentity` computes it. Releases with identical server modules share a hash; they are
 * listed oldest first. Releases without `runtime.json` (before beta.0, and the unrelated `apps`
 * packages published from 0.5.0) never supplied a framework. Computed from the npm archives; the
 * step has shipped once this is merged, so this table never changes.
 */
const publishedFrameworks: Readonly<Record<string, readonly [string, ...string[]]>> = {
  ac37ae3a48936a12ae82ef0c766b76fa522a253a2ad4885e564b49f26cf64f1a: ["0.0.1-beta.0"],
  dd50512f5b1ca9a2e031f32893eeea38952830c6ee8a0c552b16434910eced34: ["0.0.1-beta.1"],
  cbee15d2475813cf048047e9035d7e80ce978ffa4afa5a5416d82de5e52c4fef: [
    "0.0.1-beta.2",
    "0.0.1-beta.3",
  ],
  "12edbc344f2d30c6fa26a375f6f0bb4f81209cf5b91e267d3bf7d6d76057fd8d": ["0.0.1-beta.4"],
  be7c95f196974a191d86a87caa5f05280eabec24837e193745c869223308e834: ["0.0.1-beta.5"],
  "511e9b71bdea313b7d323a89bfd098036724a80e46f595ca64463949a0b78984": ["0.0.1-beta.6"],
  ec95ce08f7281b76beb17e98ab14311f0c1d4b67da39e2eaa16dce3f50c7a664: [
    "0.0.1-beta.7",
    "0.0.1-beta.8",
  ],
  d651df2ee21717fc5ae2c28d68878d98dff8179ebdc7698f2fc20b58111d3ca5: ["0.0.1-beta.9"],
  "8420607ab82145cbb87d23ebff6b310ebc1fdedb7dd3823b4695d60953ca86ec": ["0.0.1-beta.10"],
  "824e06d49ee29c3f9ffad9c838bf261187de0fe89883aa0b4dd80794d3af361c": ["0.0.1-beta.11"],
  e909e2e379f2936da84c28193d5329cc42fc7f60d67f6749298db27f6ae99004: ["0.0.1-beta.12"],
  e9953ea5ddab7bc990507bee83d74af6ddd048d31747106b1f564b8f0fbefd24: ["0.0.1-beta.13"],
  "74a1f039e15458cc224a436d86d380bc86b67a3926839f0e19a0f36136b73a61": ["0.0.1-beta.14"],
  "045c7cf02b2cabbd29b6a92df16e81ddf2e733aa2efaab7380cfbe1c44dda8b7": ["0.0.1-beta.15"],
  "0302e2436c4f8323ebaf028d62295778e9a3e47cbc67526902236d88f8a16a55": ["0.0.1-beta.16"],
};

/** An exact npm version: no range, tag or URL. */
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);

/** The `apps` release a deployment's retained source declares, if it can be read. */
const declaredApps = (deployment: DeploymentId) =>
  Effect.gen(function* () {
    const files = yield* readDeploymentSource(yield* BlobStore, deployment);
    const manifest = sourceText(files, "package.json");
    if (manifest === undefined) return undefined;
    const declared = Schema.decodeUnknownOption(Manifest)(manifest).pipe(
      Option.map((value) => value.dependencies?.apps),
      Option.getOrUndefined,
    );
    return typeof declared === "string" ? declared : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Where a framework's version label came from: the published release with its hash, the exact
 * version the deployment declares, or neither. The hash alone decides which object a build links.
 */
export type FrameworkLabelSource = "release" | "declared" | "unreleased";

/**
 * Label a framework hash: the published release with that hash (the declared one when several
 * releases share it, otherwise the oldest); else the deployment's declared `dependencies.apps`
 * when it is an exact version; else `unreleased`.
 */
const frameworkLabel = (sha256: string, deployment: DeploymentId) =>
  Effect.gen(function* () {
    const releases = publishedFrameworks[sha256];
    if (releases !== undefined) {
      if (releases.length === 1) return { version: releases[0], source: "release" as const };
      const declared = yield* declaredApps(deployment);
      return {
        version: declared !== undefined && releases.includes(declared) ? declared : releases[0],
        source: "release" as const,
      };
    }
    const declared = yield* declaredApps(deployment);
    return declared !== undefined && exactVersion.test(declared)
      ? { version: declared, source: "declared" as const }
      : { version: "unreleased", source: "unreleased" as const };
  });

/**
 * - `already-split`: `<build>/worker.json` exists and links a framework whose content matches its
 *   hash, identical to `<build>.json` when that exists too.
 * - `split`: apply wrote the record (and the framework when it was absent) and the read-back is
 *   byte-identical to the inlined build. In report mode, the in-memory split would be.
 * - `missing`: neither object exists. The build cannot load today.
 * - `invalid`: `<build>.json` does not decode, or holds no framework modules to split off.
 * - `failed`: storage failed, a stored framework does not match its hash, or the read-back
 *   differs. Retried.
 */
export const BuildSplitOutcome = Schema.Literals([
  "already-split",
  "split",
  "missing",
  "invalid",
  "failed",
]);
export type BuildSplitOutcome = typeof BuildSplitOutcome.Type;

class SplitMismatch extends Schema.TaggedError<SplitMismatch>()("SplitMismatch", {
  reason: Schema.String,
}) {}

const sameModule = (
  left: WorkerBundle["modules"][string] | undefined,
  right: WorkerBundle["modules"][string] | undefined,
) => {
  if (left === undefined || right === undefined) return false;
  if (typeof left === "string" || typeof right === "string") return left === right;
  if ("js" in left || "js" in right) return "js" in left && "js" in right && left.js === right.js;
  if (left.wasm.byteLength !== right.wasm.byteLength) return false;
  return left.wasm.every((byte, index) => byte === right.wasm[index]);
};

/** The linked build must be byte-identical to the inlined one, module by module. */
const verify = (
  inlined: InlinedBuild,
  linked: LoadedWorkerBuild,
  stored: Pick<RetainedWorkerBuild, "database" | "ui">,
) => {
  if (linked.mainModule !== inlined.mainModule) return "main module differs";
  if (linked.protocol !== inlined.protocol) return "protocol differs";
  if (stored.database !== inlined.database) return "database differs";
  if (JSON.stringify(stored.ui ?? null) !== JSON.stringify(inlined.ui ?? null))
    return "UI manifest differs";
  const names = Object.keys(inlined.modules);
  if (Object.keys(linked.modules).length !== names.length) return "module set differs";
  for (const name of names)
    if (!sameModule(inlined.modules[name], linked.modules[name])) return `module ${name} differs`;
  return undefined;
};

const isFrameworkModule = (name: string, module: WorkerBundle["modules"][string]) =>
  typeof module === "string" && name.startsWith("node_modules/apps/") && name.endsWith(".js");

const read = (key: Effect.Effect<BlobKey, Schema.SchemaError>) =>
  Effect.gen(function* () {
    return yield* (yield* BlobStore).get(yield* key);
  });

/** A record that exists, links a framework whose content has its hash, and matches `inlined`. */
const verifyStored = (build: BuildId, inlined: InlinedBuild | undefined) =>
  Effect.gen(function* () {
    const stored = yield* loadStoredWorkerBuild(build);
    if (stored.format !== 2) return yield* new SplitMismatch({ reason: "record is not split" });
    const framework = yield* loadWorkerFramework(stored.framework);
    const content = yield* frameworkIdentity({
      version: framework.version,
      modules: framework.modules,
    });
    if (content.sha256 !== stored.framework.sha256)
      return yield* new SplitMismatch({ reason: "framework content does not match its hash" });
    if (inlined === undefined) return;
    const reason = verify(inlined, yield* loadWorkerBuild(build), stored);
    if (reason !== undefined) return yield* new SplitMismatch({ reason });
  });

/** What one item of the migration did or, in report mode, would do. Counts are bytes. */
export interface BuildSplit {
  readonly outcome: BuildSplitOutcome;
  readonly reason?: string;
  readonly framework?: FrameworkIdentity & { readonly label: FrameworkLabelSource };
  /** Whether the framework object already existed before this item. */
  readonly frameworkStored?: boolean;
  readonly inlinedBytes?: number;
  readonly recordBytes?: number;
  readonly frameworkBytes?: number;
}

/**
 * Split one build. Apply writes the framework if absent (checking an existing one's hash), then
 * the record last, and verifies the read-back. Report does the same reads and checks in memory and
 * writes nothing. `deployment` is any deployment of the build, for its declared `apps` version.
 */
export const splitInlinedWorkerBuild = (
  build: BuildId,
  deployment: DeploymentId,
  mode: "report" | "apply",
) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const inlinedBody = yield* read(inlinedBuildKey(build));
    const inlined = Option.isNone(inlinedBody)
      ? undefined
      : yield* decodeJson(InlinedBuild, inlinedBody.value).pipe(Effect.option);
    const inlinedBytes = Option.isSome(inlinedBody) ? inlinedBody.value.byteLength : undefined;
    const sizes = inlinedBytes === undefined ? {} : { inlinedBytes };

    if (yield* blobs.exists(yield* buildKey(build))) {
      const checked = yield* verifyStored(
        build,
        inlined === undefined ? undefined : Option.getOrUndefined(inlined),
      ).pipe(
        Effect.as(undefined),
        Effect.catchTag("SplitMismatch", (error) => Effect.succeed(error.reason)),
        Effect.catchTag("RuntimeBuildUnavailable", () =>
          Effect.succeed("record or framework does not load"),
        ),
      );
      if (checked === undefined) return { outcome: "already-split", ...sizes } satisfies BuildSplit;
      // A record the step wrote but whose check failed is rewritten from `<build>.json`.
      if (inlined === undefined || Option.isNone(inlined))
        return { outcome: "failed", reason: checked, ...sizes } satisfies BuildSplit;
    }
    if (inlined === undefined) return { outcome: "missing" } satisfies BuildSplit;
    if (Option.isNone(inlined))
      return { outcome: "invalid", reason: "does not decode", ...sizes } satisfies BuildSplit;
    const source = inlined.value;

    const appModules: Record<string, WorkerBundle["modules"][string]> = {};
    const frameworkModules: Record<string, string> = {};
    for (const [name, module] of Object.entries(source.modules)) {
      if (isFrameworkModule(name, module) && typeof module === "string")
        frameworkModules[name] = module;
      else appModules[name] = module;
    }
    if (Object.keys(frameworkModules).length === 0)
      return { outcome: "invalid", reason: "no framework modules", ...sizes } satisfies BuildSplit;
    const { sha256 } = yield* frameworkIdentity({
      version: "unlabelled",
      modules: frameworkModules,
    });
    const label = yield* frameworkLabel(sha256, deployment);
    const identity: FrameworkIdentity = { version: label.version, sha256 };
    const framework: RetainedFramework = { ...identity, modules: frameworkModules };
    const record: RetainedWorkerBuild = {
      format: 2,
      mainModule: source.mainModule,
      modules: appModules,
      framework: identity,
      database: source.database,
      protocol: source.protocol,
      ...(source.ui === undefined ? {} : { ui: source.ui }),
    };
    const recordBody = yield* encodeJson(RetainedWorkerBuild, record);
    const frameworkBody = yield* encodeJson(RetainedFramework, framework);
    const frameworkLocation = yield* frameworkKey(identity);
    const frameworkStored = yield* blobs.exists(frameworkLocation);
    const result = {
      framework: { ...identity, label: label.source },
      frameworkStored,
      ...sizes,
      recordBytes: recordBody.byteLength,
      frameworkBytes: frameworkBody.byteLength,
    };
    if (frameworkStored) {
      const existing = yield* loadWorkerFramework(identity).pipe(Effect.option);
      const content = Option.isNone(existing)
        ? undefined
        : yield* frameworkIdentity({
            version: existing.value.version,
            modules: existing.value.modules,
          });
      if (content?.sha256 !== sha256)
        return {
          outcome: "failed",
          reason: "stored framework does not match its hash",
          ...result,
        } satisfies BuildSplit;
    }

    if (mode === "report") {
      const linked = yield* linkWorkerBuild(record, () => Effect.succeed(framework));
      const reason = verify(source, linked, record);
      return (
        reason === undefined
          ? { outcome: "split", ...result }
          : { outcome: "failed", reason, ...result }
      ) satisfies BuildSplit;
    }

    // The framework first and the record last: a reader uses `<build>.json` until the record exists.
    if (!frameworkStored) yield* blobs.put(frameworkLocation, frameworkBody);
    yield* blobs.put(yield* buildKey(build), recordBody);
    const reason = yield* verifyStored(build, source).pipe(
      Effect.as(undefined),
      Effect.catchTag("SplitMismatch", (error) => Effect.succeed(error.reason)),
      Effect.catchTag("RuntimeBuildUnavailable", () =>
        Effect.succeed("record or framework does not load"),
      ),
    );
    return (
      reason === undefined
        ? { outcome: "split", ...result }
        : { outcome: "failed", reason, ...result }
    ) satisfies BuildSplit;
  }).pipe(
    // Storage failures leave the item to retry; the next pass reads everything again.
    Effect.catch(() =>
      Effect.succeed({
        outcome: "failed",
        reason: "storage or encoding failed",
      } satisfies BuildSplit),
    ),
    Effect.map((split): BuildSplit => split),
    Effect.tap((split) =>
      Effect.annotateCurrentSpan({
        "executor.build.split.outcome": split.outcome,
        ...(split.reason === undefined ? {} : { "executor.build.split.reason": split.reason }),
        ...(split.framework === undefined
          ? {}
          : {
              "executor.build.framework": `${split.framework.version}-${split.framework.sha256}`,
              "executor.build.framework_label": split.framework.label,
            }),
        ...(split.frameworkStored === undefined
          ? {}
          : { "executor.build.framework_stored": split.frameworkStored }),
        ...(split.inlinedBytes === undefined
          ? {}
          : { "executor.build.inlined_bytes": split.inlinedBytes }),
        ...(split.recordBytes === undefined
          ? {}
          : { "executor.build.record_bytes": split.recordBytes }),
        ...(split.frameworkBytes === undefined
          ? {}
          : { "executor.build.framework_bytes": split.frameworkBytes }),
      }),
    ),
    Effect.withSpan("runtime.build.split", {
      attributes: { "executor.build.id": build, "executor.build.split.mode": mode },
    }),
  );
