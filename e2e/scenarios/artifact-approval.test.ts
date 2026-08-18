// Cross-target: approving a destructive action triggered from inside an
// artifact.
//
// This is the console's own path, not MCP. The artifact page has no MCP client,
// so the shell's host adapter posts `POST /executions` (with the artifact id)
// and then `POST /executions/:id/resume` when the human answers the modal. The
// existing approval coverage all runs over MCP, where the engine lives for the
// lifetime of a session Durable Object — so none of it could see that on a host
// building an executor per request the pause and the resume land on DIFFERENT
// engine instances, and the approval failed with `ExecutionNotFoundError`.
//
// Two things are asserted that the older scenarios could not:
//
//   1. The approval is honoured at all on this path, and the side effect lands.
//   2. It is honoured by a later request after the engine that paused is gone.
//      The reported symptom involved an approval after "tens of seconds", but
//      the bug itself was not time-based: a resume 7ms after the pause failed
//      identically. The SDK store tests advance a controlled clock across the
//      complete approval lease; this scenario covers the cross-request path
//      without making every CI run wait on wall clock.
import { randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import type { ArtifactId } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

/**
 * The one call the shell's proxy is allowed to emit: a single awaited tool call,
 * no statements around it. `policies.create` carries a `requiresApproval`
 * annotation, so with no matching policy in play the annotation is the only
 * thing that can pause it — and the pattern is unique-per-run and matches no
 * real tool, so the created rule is inert.
 *
 * `executor` is a reserved tool root (`RESERVED_TOOL_ROOTS`), so it resolves
 * without a connection binding — which lets the scenario exercise the
 * artifact-scoped approval path without first connecting an integration.
 */
const artifactActionCode = (pattern: string) =>
  `return await tools.executor.coreTools.policies.create(${JSON.stringify({
    owner: "user",
    pattern,
    action: "block",
  })})`;

/** A minimal artifact. Its source is irrelevant to the approval path — what
 *  matters is that a real artifact id scopes the call, exactly as the rendered
 *  page supplies it. */
const artifactSource = `
function App() {
  return <div data-testid="approval-artifact">Approval fixture</div>;
}
`;

const pausedExecutionId = (structured: unknown): string | undefined =>
  (structured as { readonly executionId?: string } | null)?.executionId;

scenario(
  "Artifacts · a destructive action approved from an artifact runs from a later request",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(coreApi, identity);

    const pattern = `artifact-approval-${randomUUID().slice(0, 8)}.*`;
    const code = artifactActionCode(pattern);

    const artifact = yield* client.artifacts.save({
      payload: {
        title: `Approval fixture ${randomUUID().slice(0, 8)}`,
        code: artifactSource,
      },
    });

    const cleanup = Effect.all(
      [
        client.artifacts
          .remove({ params: { artifactId: artifact.id as ArtifactId } })
          .pipe(Effect.ignore),
        client.policies.list().pipe(
          Effect.flatMap((list) =>
            Effect.forEach(
              list.filter((p) => p.pattern === pattern),
              (p) =>
                client.policies
                  .remove({ params: { policyId: p.id }, payload: { owner: "user" } })
                  .pipe(Effect.ignore),
            ),
          ),
          Effect.ignore,
        ),
      ],
      { discard: true },
    );

    yield* Effect.gen(function* () {
      // The artifact fires its mutation. The tool gates itself, so the shell
      // gets a pause back and renders the approval modal.
      const paused = yield* client.executions.execute({
        payload: { code, artifactId: artifact.id },
      });
      expect(paused.status, "a destructive artifact action pauses for approval").toBe("paused");
      if (paused.status !== "paused") return; // narrowing only

      const executionId = pausedExecutionId(paused.structured);
      expect(executionId, "the pause carries an execution id to approve").toBeTruthy();
      if (!executionId) return; // narrowing only

      // Nothing may happen while the human is still deciding.
      const beforeApproval = yield* client.policies.list();
      expect(
        beforeApproval.some((p) => p.pattern === pattern),
        "the action does not run while it is waiting on approval",
      ).toBe(false);

      const approved = yield* client.executions.resume({
        params: { executionId },
        payload: { action: "accept", content: {} },
      });

      expect(approved.status, "approving the action runs it to completion").toBe("completed");
      if (approved.status !== "completed") return; // narrowing only
      expect(approved.isError, "the approved action is not an error").toBe(false);

      const afterApproval = yield* client.policies.list();
      expect(
        afterApproval.some((p) => p.pattern === pattern),
        "the approved action's side effect actually landed",
      ).toBe(true);
    }).pipe(Effect.ensuring(cleanup));
  }),
);

scenario(
  "Artifacts · declining an artifact action leaves it unrun",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const apiSurface = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiSurface.client(coreApi, identity);

    const pattern = `artifact-decline-${randomUUID().slice(0, 8)}.*`;
    const code = artifactActionCode(pattern);

    const artifact = yield* client.artifacts.save({
      payload: {
        title: `Decline fixture ${randomUUID().slice(0, 8)}`,
        code: artifactSource,
      },
    });

    const cleanup = Effect.all(
      [
        client.artifacts
          .remove({ params: { artifactId: artifact.id as ArtifactId } })
          .pipe(Effect.ignore),
        client.policies.list().pipe(
          Effect.flatMap((list) =>
            Effect.forEach(
              list.filter((p) => p.pattern === pattern),
              (p) =>
                client.policies
                  .remove({ params: { policyId: p.id }, payload: { owner: "user" } })
                  .pipe(Effect.ignore),
            ),
          ),
          Effect.ignore,
        ),
      ],
      { discard: true },
    );

    yield* Effect.gen(function* () {
      const paused = yield* client.executions.execute({
        payload: { code, artifactId: artifact.id },
      });
      expect(paused.status, "the action pauses for approval").toBe("paused");
      if (paused.status !== "paused") return; // narrowing only

      const executionId = pausedExecutionId(paused.structured);
      if (!executionId) return; // narrowing only

      yield* client.executions.resume({
        params: { executionId },
        payload: { action: "decline" },
      });

      const afterDecline = yield* client.policies.list();
      expect(
        afterDecline.some((p) => p.pattern === pattern),
        "a declined action never runs",
      ).toBe(false);

      // A declined approval is spent: the same id cannot be re-approved into a
      // run afterwards.
      yield* client.executions
        .resume({ params: { executionId }, payload: { action: "accept", content: {} } })
        .pipe(Effect.ignore);

      const afterRetry = yield* client.policies.list();
      expect(
        afterRetry.some((p) => p.pattern === pattern),
        "approving after a decline does not resurrect the action",
      ).toBe(false);
    }).pipe(Effect.ensuring(cleanup));
  }),
);
