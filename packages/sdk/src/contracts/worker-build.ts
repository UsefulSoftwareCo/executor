/** Retained Worker code and optional private browser asset metadata. */
import { UiAsset } from "./runtime.ts";
import { Effect, Schema } from "effect";

export { WorkerBundle } from "@executor-js/app-data/worker-bundle";
import { WorkerBundle } from "@executor-js/app-data/worker-bundle";
export type WorkerBundle = typeof WorkerBundle.Type;

/** A host protocol number. Whether this host runs it is decided by its protocol adapters. */
export const AppProtocolVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * An executable `apps` framework: the host protocol it speaks and its ready-to-link server and
 * browser modules. Published packages carry it as `runtime.json`; hosts carry their own snapshot.
 */
export const PublishedAppFramework = Schema.Struct({
  protocol: AppProtocolVersion,
  version: Schema.NonEmptyString,
  server: Schema.Record(Schema.String, Schema.String),
  browser: Schema.Record(Schema.String, Schema.String),
});
export type AppFramework = typeof PublishedAppFramework.Type;

/** The server modules of the `apps` release a build links against, exactly as published. */
export const WorkerFramework = Schema.Struct({
  version: Schema.NonEmptyString,
  modules: Schema.Record(Schema.String, Schema.String),
});
export type WorkerFramework = typeof WorkerFramework.Type;

/**
 * A framework release and the SHA-256 of its server modules. The hash, not the version, decides
 * which stored framework a build links: an unpublished test framework can reuse a version label.
 */
export const FrameworkIdentity = Schema.Struct({
  version: Schema.NonEmptyString,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
export type FrameworkIdentity = typeof FrameworkIdentity.Type;

/** One stored framework, written once and shared by every build that links it. */
export const RetainedFramework = Schema.Struct({
  ...FrameworkIdentity.fields,
  modules: WorkerFramework.fields.modules,
});
export type RetainedFramework = typeof RetainedFramework.Type;

/**
 * The stored build: the app's own modules and the identity of the framework they link. Format 2
 * is the first format that stores the framework separately; builds without the marker inline it.
 */
export const RetainedWorkerBuild = Schema.Struct({
  format: Schema.Literal(2),
  ...WorkerBundle.fields,
  framework: FrameworkIdentity,
  database: Schema.Boolean,
  ui: Schema.optional(Schema.Array(UiAsset)),
  protocol: AppProtocolVersion,
});
export type RetainedWorkerBuild = typeof RetainedWorkerBuild.Type;

/**
 * A build retained before frameworks were stored once, with the framework's modules inlined.
 * Read only until the one-off migration in notes/build-framework-migration.md has rewritten every
 * stored build; then delete this schema and `StoredWorkerBuild` becomes `RetainedWorkerBuild`.
 */
export const InlinedWorkerBuild = Schema.Struct({
  format: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
  ...WorkerBundle.fields,
  database: Schema.Boolean,
  ui: Schema.optional(Schema.Array(UiAsset)),
  /** Every build retained before protocols were recorded speaks protocol 1, the only one then. */
  protocol: AppProtocolVersion.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
});

/** What a build's stored record decodes to while the migration window is open. */
export const StoredWorkerBuild = Schema.Union([RetainedWorkerBuild, InlinedWorkerBuild]);
export type StoredWorkerBuild = typeof StoredWorkerBuild.Type;

/**
 * The code a runner loads when it cold-starts a build's Worker, with the host protocol its
 * framework speaks. The runner learns a build's protocol from this load, so warm calls read none.
 */
export const LoadedWorkerBuild = Schema.Struct({
  ...WorkerBundle.fields,
  protocol: AppProtocolVersion,
});
export type LoadedWorkerBuild = typeof LoadedWorkerBuild.Type;
