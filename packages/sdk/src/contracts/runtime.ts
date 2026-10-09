/** Pluggable Effect runtime. The caller resolves accounts; no database or owner policy lives here. */
import { Context, Effect, Schema, type Stream } from "effect";
import {
  HostDeclarationInvalid,
  DeclaredRequirements,
  type AccountCheckResult,
  type HostAccountCheckError,
  type HostInspectError,
  type HostCallError,
  type HostDataError,
  type HostedCatalog,
  type HostedCatalogSummary,
  type MigrateResult,
  type SkillCatalog,
  type HostContext,
  type WebhookCommand,
  type WorkflowCommand,
} from "apps/contracts";
import { DatabaseFieldReserved } from "@executor-js/app-data/contracts";
import { RecordedMessage } from "@executor-js/utils/recorded-message";
import { BuildStage, SourceFiles, SourceLocation, type BuildMemoryExceeded } from "./deployment.ts";
import { BuildId, Json } from "./shared.ts";

/**
 * Runtimes report that an invocation invalidated or explicitly refreshed the app's cached
 * upstream data, such as an MCP catalog after `notifications/tools/list_changed`, including one
 * that happens after the invocation. The SDK then stops reusing results it evaluated for that app
 * from the earlier data. Routine refreshes are not reported; kept results pick them up when they
 * refresh.
 */
export const AppCacheChanges = Context.Reference<{
  readonly changed: (app: string) => Effect.Effect<void>;
}>("executor/AppCacheChanges", { defaultValue: () => ({ changed: () => Effect.void }) });

/**
 * One isolate's own part of an invocation, on its own clock: how long it took and how much of that
 * it waited on the next isolate. The runner and the data supervisor report it beside their reply.
 */
export const IsolateTiming = Schema.Struct({
  elapsedMs: Schema.Finite,
  waitMs: Schema.Finite,
});
export type IsolateTiming = typeof IsolateTiming.Type;

/**
 * The app isolate's whole part of an invocation, on its clock, from the runtime's bridge: the app's
 * spans and the framework's work around them. The bridge adds it beside the app's reply.
 */
export const DispatchTiming = Schema.Struct({ elapsedMs: Schema.Finite });
export type DispatchTiming = typeof DispatchTiming.Type;

/**
 * One runtime call's share of a tool call, reported when the call is over. Workers clocks are not
 * comparable across isolates, so the caller measures only its own wait and every other isolate
 * reports its own part on its own clock.
 */
export interface RuntimeCallTiming {
  /** When the caller waited on the runner, on its own clock. Absent if the call never got there. */
  readonly invoked?: readonly [start: bigint, end: bigint];
  /**
   * The other isolates' parts. Absent when the call was invoked but did not finish, or its build
   * or runner predates timing; the call's Executor time is then unknown.
   */
  readonly parts?: {
    /** The runner's, data supervisor's and app isolate's own time, each on its own clock. */
    readonly ownMs: number;
    /** The app isolate's own time, which `ownMs` includes. */
    readonly appOwnMs: number;
    readonly upstreamMs: number;
    readonly elicitationMs: number;
    readonly authoredMs: number;
    /** Adjacent isolates whose clocks disagree, such as `runner/app`: a lower bound. */
    readonly staleClocks: readonly string[];
  };
}

/** Receives each runtime call's timing within one tool call. Telemetry only. */
export const RuntimeCallTimings = Context.Reference<
  ((timing: RuntimeCallTiming) => void) | undefined
>("executor/RuntimeCallTimings", { defaultValue: () => undefined });

/**
 * Where an invocation's emitted events go once it succeeds. The executor provides it around every
 * runtime call. When they cannot be saved the call fails, so its caller retries it; the events'
 * stable IDs keep a retry from delivering them twice. A call with no sink fails the same way.
 */
export const AppEventSink = Context.Reference<{
  readonly emitted: (input: {
    readonly app: string;
    /** Every account bound to the invocation: its events may carry data from any of them. */
    readonly accounts: readonly string[];
    readonly events: readonly import("apps/contracts").EmittedEvent[];
  }) => Effect.Effect<void, RuntimeProtocolFailed>;
}>("executor/AppEventSink", {
  defaultValue: () => ({
    emitted: () =>
      Effect.logError("App events were emitted where no event sink was provided").pipe(
        Effect.andThen(Effect.fail(new RuntimeProtocolFailed({ reason: "data" }))),
      ),
  }),
});

/**
 * The scheduled run an app invocation serves, if any. The runner records it on the build loads it
 * makes for the invocation, so a query can tell a run's own build loads from those of other runs
 * that share its scheduler trace. Telemetry only: nothing decides on it.
 */
export const InvocationRun = Context.Reference<string | undefined>("executor/InvocationRun", {
  defaultValue: () => undefined,
});

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

/** Longest build or protocol diagnostic retained on an error. */
export const maxBuildMessageLength = 4096;
/** Bounded diagnostic text about the deployer's own source, such as a compiler error. */
export const BuildMessage = Schema.String.check(Schema.isMaxLength(maxBuildMessageLength));
/** Truncate diagnostic text to its bound. */
export const boundBuildMessage = (message: string) =>
  message.length <= maxBuildMessageLength
    ? message
    : `${message.slice(0, maxBuildMessageLength - 1)}…`;
/**
 * Describe an underlying failure as `Name: message`, bounded. Executor's own wrappers of an
 * underlying failure contribute only their message.
 */
export const describeBuildCause = (cause: unknown) =>
  boundBuildMessage(
    cause instanceof Error
      ? cause.message.length > 0
        ? Schema.is(RuntimeProtocolFailed)(cause) || Schema.is(HostDeclarationInvalid)(cause)
          ? cause.message
          : `${cause.name}: ${cause.message}`
        : cause.name
      : typeof cause === "string"
        ? cause
        : (JSON.stringify(cause) ?? String(cause)),
  );

/**
 * A build failed; no build reference is returned and staging output is removed. `message`
 * describes the underlying failure in the deployer's own source when it is known, with the
 * first failing source location. It never contains credentials: builds bind no accounts.
 */
export class RuntimeBuildFailed extends Schema.TaggedError<RuntimeBuildFailed>()(
  "RuntimeBuildFailed",
  {
    stage: BuildStage,
    dependency: Schema.optional(Schema.String),
    /** A named declaration problem the author can fix, reported with the failed deploy. */
    declaration: Schema.optional(DatabaseFieldReserved),
    message: Schema.optional(BuildMessage),
    location: Schema.optional(SourceLocation),
  },
) {
  /** The message quotes the deployer's source or its errors; telemetry records only the stage. */
  get [RecordedMessage]() {
    return `The build failed at its ${this.stage} stage`;
  }
}
/** The retained build was absent, invalid or could not load in this host. */
export class RuntimeBuildUnavailable extends Schema.TaggedError<RuntimeBuildUnavailable>()(
  "RuntimeBuildUnavailable",
  {},
) {}
/**
 * Each way an app's Worker or data facet can fail a call without an answer from the app's code.
 * The platform kinds match the data facet's own: a call's runtime and its data facet fail alike.
 */
export const RuntimeFailure = Schema.Literals([
  "cold-start",
  "memory",
  "cpu",
  "timeout",
  "overloaded",
  "reset",
  "disconnected",
  "hung",
  "internal",
  "invalid-reply",
  "data",
  "build",
  "unsupported",
  "unrecognized",
]);
export type RuntimeFailure = typeof RuntimeFailure.Type;
/** The fixed description of each runtime failure, for the host's diagnostics. */
export const runtimeFailures: Record<RuntimeFailure, string> = {
  "cold-start": "The app's Worker could not be loaded",
  memory: "The app's Worker exceeded its memory limit",
  cpu: "The app's Worker exceeded its CPU time limit",
  timeout: "The app's Worker exceeded a time limit",
  overloaded: "The app's Worker was overloaded",
  reset: "The runtime reset the app's Worker",
  disconnected: "The connection to the app's Worker was lost",
  hung: "The app's Worker can never answer",
  internal: "The runtime failed internally",
  "invalid-reply": "The app's reply does not match its host protocol",
  data: "The app's data supervisor failed the call",
  build: "The app's build could not be read",
  unsupported: "The app's build speaks a host protocol this host does not run",
  unrecognized: "The app's Worker failed for a reason the runtime did not recognize",
};
/**
 * The framework handler returned an invalid protocol response, or its Worker failed to load or
 * run. `reason` is the kind of failure, the only part telemetry records. `message` is the failure
 * in the app's own terms, which can quote the app's text; only a deploy's declaration step sets
 * it, for the deployer. Tool callers never receive it.
 */
export class RuntimeProtocolFailed extends Schema.TaggedError<RuntimeProtocolFailed>()(
  "RuntimeProtocolFailed",
  { reason: Schema.optional(RuntimeFailure), message: Schema.optional(BuildMessage) },
) {
  get [RecordedMessage]() {
    return this.reason === undefined && !this.message
      ? undefined
      : runtimeFailures[this.reason ?? "unrecognized"];
  }
}
/**
 * The app's `apps` framework speaks a host protocol this host does not run. Builds fail before
 * compiling, and retained builds fail before loading, rather than at module link or decode time.
 */
export class RuntimeProtocolUnsupported extends Schema.TaggedError<RuntimeProtocolUnsupported>()(
  "RuntimeProtocolUnsupported",
  { protocol: Schema.Int, supported: Schema.Array(Schema.Int) },
) {
  override get message() {
    return `This app's apps framework uses host protocol ${this.protocol}. This host supports protocol ${this.supported.join(", ")}.`;
  }
  get [RecordedMessage]() {
    return this.message;
  }
}
/**
 * The app's `package.json` declares no `apps` version. Every app declares the exact release it uses;
 * `version` is the one this host ships, which new apps pin.
 */
export class RuntimeAppsDependencyMissing extends Schema.TaggedError<RuntimeAppsDependencyMissing>()(
  "RuntimeAppsDependencyMissing",
  { version: Schema.NonEmptyString },
) {
  override get message() {
    return `Add "apps": "${this.version}" to package.json dependencies. Every app declares the exact apps version it uses; ${this.version} is this host's.`;
  }
  get [RecordedMessage]() {
    return this.message;
  }
}
/** Loading retained code and decoding the framework protocol are host failures. */
export type RuntimeLoadError =
  | RuntimeBuildUnavailable
  | RuntimeProtocolFailed
  | RuntimeProtocolUnsupported;

/** Framework-facing operations, independent of Node or Cloudflare bindings. */
export interface Runtime<Requirements = never> {
  /** Optional cross-process invalidation feed. The initial event follows registration.
   * A revision identifies all writes before that event; unversioned hosts emit void.
   */
  readonly changes?: (app: string) => Stream.Stream<number | void, RuntimeLoadError>;
  /** Sources build with the `apps` package they declare; sources without one are rejected. */
  readonly build: (input: {
    readonly files: SourceFiles;
  }) => Effect.Effect<
    BuiltApp,
    | RuntimeBuildFailed
    | RuntimeProtocolUnsupported
    | RuntimeAppsDependencyMissing
    | BuildMemoryExceeded,
    Requirements
  >;
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
      /** Describe only declared operations with schedules. Send only to scheduledTools builds. */
      readonly scheduled?: true;
    } & HostContext,
  ) => Effect.Effect<HostedCatalog, RuntimeLoadError | typeof HostInspectError.Type, Requirements>;
  /** List the current tools without their schemas. */
  readonly index: (
    input: { readonly app: string; readonly build: BuildId } & HostContext,
  ) => Effect.Effect<
    HostedCatalogSummary,
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
      /** Decides the storage mode before the app runs; the host verifies it. */
      readonly kind?: "query" | "mutation";
      readonly input: Json;
    } & HostContext,
  ) => Effect.Effect<Json, RuntimeLoadError | typeof HostCallError.Type, Requirements>;
  /**
   * Run one slot's provider check with the single account in `accounts`, without evaluating the
   * app. Send only to builds whose requirements declare a check for that slot.
   */
  readonly checkAccount: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly requirement: string;
    } & HostContext,
  ) => Effect.Effect<
    AccountCheckResult,
    RuntimeLoadError | typeof HostAccountCheckError.Type,
    Requirements
  >;
  /**
   * Apply a build's pending SQL migrations to its app's database, before the build is activated.
   * Send only to builds whose requirements declare `sql`.
   */
  readonly migrate: (input: {
    readonly app: string;
    readonly build: BuildId;
  }) => Effect.Effect<MigrateResult, RuntimeLoadError | typeof HostCallError.Type, Requirements>;
}
