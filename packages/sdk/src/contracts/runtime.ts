/** Pluggable Effect runtime. The caller resolves accounts; no database or owner policy lives here. */
import { Schema, type Effect, type Stream } from "effect";
import {
  DeclaredRequirements,
  type HostInspectError,
  type HostCallError,
  type HostDataError,
  type HostedTool,
  type HostedToolSummary,
  type SkillCatalog,
  type HostContext,
  type WebhookCommand,
  type WorkflowCommand,
} from "apps/contracts";
import { SourceFiles, type BuildMemoryExceeded } from "./deployment.ts";
import { BuildId, Json } from "./shared.ts";

/** Retained compiled output and declarations obtained without running the app factory. */
export const UiAsset = Schema.Struct({
  path: Schema.NonEmptyString,
  contentType: Schema.NonEmptyString,
});
/** Browser assets retained atomically with the server bundle. */
export const BuiltApp = Schema.Struct({
  build: BuildId,
  requirements: DeclaredRequirements,
  ui: Schema.optional(Schema.Array(UiAsset)),
});
/** A private browser asset returned to an authenticated serving host. */
export interface RuntimeAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
}
/** Parsed successful build result. */
export type BuiltApp = typeof BuiltApp.Type;

/** A build failed; no build reference is returned and staging output is removed. */
export class RuntimeBuildFailed extends Schema.TaggedError<RuntimeBuildFailed>()(
  "RuntimeBuildFailed",
  {
    stage: Schema.Literals(["source", "dependencies", "compile", "declaration", "retain"]),
    dependency: Schema.optional(Schema.String),
  },
) {}
/** The retained build was absent, invalid or could not load in this host. */
export class RuntimeBuildUnavailable extends Schema.TaggedError<RuntimeBuildUnavailable>()(
  "RuntimeBuildUnavailable",
  {},
) {}
/** The framework handler returned an invalid protocol response. */
export class RuntimeProtocolFailed extends Schema.TaggedError<RuntimeProtocolFailed>()(
  "RuntimeProtocolFailed",
  {},
) {}
/** Loading retained code and decoding the framework protocol are host failures. */
export type RuntimeLoadError = RuntimeBuildUnavailable | RuntimeProtocolFailed;

/** Framework-facing operations, independent of Node or Cloudflare bindings. */
export interface Runtime<Requirements = never> {
  /** Optional cross-process invalidation feed. The initial event follows registration.
   * A revision identifies all writes before that event; unversioned hosts emit void.
   */
  readonly changes?: (app: string) => Stream.Stream<number | void, RuntimeLoadError>;
  readonly build: (input: {
    readonly files: SourceFiles;
  }) => Effect.Effect<BuiltApp, RuntimeBuildFailed | BuildMemoryExceeded, Requirements>;
  readonly asset?: (input: {
    readonly build: BuildId;
    readonly path: string;
  }) => Effect.Effect<RuntimeAsset | undefined, RuntimeBuildUnavailable, Requirements>;
  /**
   * Evaluate the current app skill catalog with the same selected account context as tools.
   * `sources` also reports whether a live loader contributed; send it only to builds that
   * declare the skillSources capability.
   */
  readonly skills: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly sources?: boolean;
    } & HostContext,
  ) => Effect.Effect<SkillCatalog, RuntimeLoadError | typeof HostInspectError.Type, Requirements>;
  /** Describe the current tools, or only the named ones. Unknown names are omitted. */
  readonly inspect: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly tools?: readonly string[];
    } & HostContext,
  ) => Effect.Effect<
    readonly HostedTool[],
    RuntimeLoadError | typeof HostInspectError.Type,
    Requirements
  >;
  /** List the current tools without their schemas. */
  readonly index: (
    input: { readonly app: string; readonly build: BuildId } & HostContext,
  ) => Effect.Effect<
    readonly HostedToolSummary[],
    RuntimeLoadError | typeof HostInspectError.Type,
    Requirements
  >;
  readonly query: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly database: boolean;
      /** Report the storage revision read by this successful query, never an authored result. */
      readonly observeRevision?: (revision: number) => void;
      readonly name: string;
      readonly input: Json;
    } & HostContext,
  ) => Effect.Effect<Json, RuntimeLoadError | typeof HostDataError.Type, Requirements>;
  readonly mutate: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly database: boolean;
      readonly name: string;
      readonly input: Json;
    } & HostContext,
  ) => Effect.Effect<Json, RuntimeLoadError | typeof HostDataError.Type, Requirements>;
  /** Execute a webhook lifecycle command against its retained build. */
  readonly webhook: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly database: boolean;
      readonly command: WebhookCommand;
    } & HostContext,
  ) => Effect.Effect<Json, RuntimeLoadError | typeof HostCallError.Type, Requirements>;
  /** Discover or execute workflows against the same retained app build. */
  readonly workflow: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly command: WorkflowCommand;
    } & HostContext,
  ) => Effect.Effect<Json, RuntimeLoadError | typeof HostCallError.Type, Requirements>;
  readonly call: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly database: boolean;
      readonly tool: string;
      readonly input: Json;
    } & HostContext,
  ) => Effect.Effect<Json, RuntimeLoadError | typeof HostCallError.Type, Requirements>;
}
