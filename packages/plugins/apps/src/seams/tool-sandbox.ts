import type { Effect } from "effect";
import { Data } from "effect";

// ---------------------------------------------------------------------------
// ToolSandbox — the isolated substrate that runs published bundles.
//
// Two operations, both over a bundled JS string (esbuild output, platform
// modules external, zod inlined):
//
//   collect(bundle): import the bundle with NOTHING bound. `define*` calls
//     return descriptors; a collector shim gathers them and returns JSON. This
//     is how the publish pipeline extracts the versioned descriptor from source
//     without ever running effectful code. Run twice + byte-compare = the
//     determinism gate (a bundle that reads Math.random / Date.now at the top
//     level or in a describe path diverges and is rejected).
//
//   invoke(bundle, request): run one artifact's handler. The handler receives
//     pre-bound clients whose method calls cross OUT through a serializable
//     bridge (`HandleBridge.call`). EVERYTHING crossing the boundary is
//     serializable — the cloud version of this seam is an RPC, so the interface
//     forbids passing functions or live objects across. Fan-out arrays
//     (`connections("gmail")` -> client[]) are modeled as indexed handle roots.
//
// The self-hosted backing is QuickJS (packages/kernel/runtime-quickjs), whose
// `SandboxToolInvoker.invoke({path, args})` already matches the bridge shape.
// The cloud backing (future) is Worker Loaders. The Deno subprocess kernel is
// the harder-isolation escalation behind this same seam.
// ---------------------------------------------------------------------------

export class ToolSandboxError extends Data.TaggedError("ToolSandboxError")<{
  readonly message: string;
  readonly kind: "collect" | "invoke" | "timeout" | "network" | "nondeterministic" | "bundle";
  readonly cause?: unknown;
}> {}

/**
 * The serializable bridge the sandbox calls out through. `root` names an
 * injected handle (a connection role, `db`, or one element of a fan-out set);
 * `path` is the method chain (`["events", "list"]`); `args` is the JSON call
 * arguments. The return value is JSON. This is the ONE way sandboxed code
 * reaches the host — nothing else is wired.
 */
export interface HandleBridge {
  readonly call: (input: {
    readonly root: string;
    readonly path: readonly string[];
    readonly args: readonly unknown[];
  }) => Effect.Effect<unknown, ToolSandboxError>;
}

/** Which handle roots to inject and, for fan-out roots, how many elements. A
 *  single connection role is `{ kind: "single" }`; a fan-out is
 *  `{ kind: "array", count }`; `db` is a single. Everything the handler can see
 *  is enumerated here — undeclared roots are simply absent. */
export type HandleRootSpec =
  | { readonly kind: "single" }
  | { readonly kind: "array"; readonly count: number };

export interface InvokeRequest {
  /** The artifact whose handler to run (path identity, e.g. `issues-sync`). */
  readonly artifact: string;
  /** The kind selects the wrapper the sandbox uses to reach the handler. */
  readonly kind: "tool";
  /** JSON input passed to the handler. */
  readonly input: unknown;
  /** The handle roots to inject, keyed by the name the handler destructures
   *  (`github`, `db`, `inboxes`). */
  readonly roots: Readonly<Record<string, HandleRootSpec>>;
}

export interface InvokeResult {
  readonly output: unknown;
  readonly logs: readonly string[];
}

/** A collected artifact descriptor — the JSON `define*` returns. The pipeline
 *  refines this into the versioned descriptor; the sandbox only guarantees it
 *  is deterministic JSON. */
export interface CollectedArtifact {
  readonly kind: "tool" | "workflow";
  readonly descriptor: unknown;
}

export interface CollectResult {
  /** Descriptors keyed by artifact path identity. */
  readonly artifacts: Readonly<Record<string, CollectedArtifact>>;
}

export interface ToolSandbox {
  /**
   * Import the bundle with nothing bound and gather every `define*` descriptor.
   * Runs the collection twice internally and byte-compares; a mismatch fails
   * with `kind: "nondeterministic"`. This is the determinism gate.
   */
  readonly collect: (bundle: string) => Effect.Effect<CollectResult, ToolSandboxError>;
  /**
   * Run one artifact's handler with injected handles bridged through `bridge`.
   * Network is denied; a per-call timeout kills a runaway handler.
   */
  readonly invoke: (
    bundle: string,
    request: InvokeRequest,
    bridge: HandleBridge,
  ) => Effect.Effect<InvokeResult, ToolSandboxError>;
}
