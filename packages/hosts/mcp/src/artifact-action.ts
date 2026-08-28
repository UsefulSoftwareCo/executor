/**
 * One artifact-originated call, resolved into the code that actually runs.
 *
 * Two surfaces carry these calls, and they must agree exactly:
 *
 *  - `execute-action`, when the artifact renders inside an MCP-Apps client;
 *  - `POST /executions` with an `artifactId`, when it renders on the console's
 *    own artifact page (there is no MCP client there, so the shell's host
 *    adapter speaks HTTP instead).
 *
 * The same iframe, the same generated component and the same proxy sit behind
 * both. If only one of them constrained the grammar or applied the bindings,
 * the other would be a way around it — so the logic lives here and each surface
 * only formats the outcome in its own vocabulary.
 *
 * Resolution is: parse the code against the proxy's grammar, load the artifact,
 * rewrite the role into a connection, re-emit the call. The code that reaches
 * the engine is built here from a parsed path and a stored binding; the string
 * the iframe sent is never executed.
 */

import { Effect } from "effect";
import type { Artifact } from "@executor-js/sdk";

import { resolveCallAddress } from "./artifact-bindings";
import { formatToolCallCode, parseToolCallCode } from "./tool-call-code";

export type ArtifactActionResolution =
  /** Run this. Built from the parsed path plus the artifact's bindings. */
  | { readonly status: "ok"; readonly code: string }
  /** Not the shape the proxy emits. */
  | { readonly status: "invalid_action_code" }
  /** The artifact is missing, or isn't this caller's. One outcome for both, so
   *  the channel can't be used to probe for ids that exist. */
  | { readonly status: "artifact_unavailable" }
  /** The call names an integration role the artifact has no connection for. */
  | {
      readonly status: "binding_unresolved";
      readonly role: string;
      readonly integration: string;
      readonly message: string;
    };

/**
 * `loadArtifact` is the caller's OWN scoped read. Ownership is therefore
 * enforced by the same query that fetches the row — an id belonging to someone
 * else simply doesn't resolve — rather than by a separate check that could
 * drift from it.
 *
 * A missing `artifactId` is treated as an artifact with no bindings: a call
 * that already carries a full address runs as written (that is the
 * pre-binding-contract path), a short one has nothing to resolve against and is
 * refused.
 */
export const resolveArtifactAction = (input: {
  readonly code: string;
  readonly artifactId: string | undefined;
  readonly loadArtifact: (id: string) => Effect.Effect<Artifact | null>;
}): Effect.Effect<ArtifactActionResolution> =>
  Effect.gen(function* () {
    const call = parseToolCallCode(input.code);
    if (!call) return { status: "invalid_action_code" } as const;

    const artifact =
      input.artifactId === undefined ? null : yield* input.loadArtifact(input.artifactId);
    if (input.artifactId !== undefined && !artifact) {
      return { status: "artifact_unavailable" } as const;
    }

    const resolved = resolveCallAddress({
      path: call.path,
      role: call.role,
      bindings: artifact?.bindings ?? null,
    });
    if (!resolved.ok) {
      return input.artifactId === undefined
        ? ({ status: "artifact_unavailable" } as const)
        : ({
            status: "binding_unresolved",
            role: resolved.role,
            integration: resolved.integration,
            message: resolved.message,
          } as const);
    }

    return { status: "ok", code: formatToolCallCode(resolved.path, call.args) } as const;
  });
