// ---------------------------------------------------------------------------
// In-process browser-approval store — the single-process equivalent of the
// Durable Object's persisted approval responses (apps/cloud, host-cloudflare).
//
// It is the bridge between the two halves of a browser approval:
//   - the MCP `resume` tool long-polls `store.waitForResponse(executionId)`,
//   - the HTTP approval endpoint records the human's decision via
//     `recordResponse(executionId, response)`, which wakes that waiter.
//
// Keyed by executionId alone — execution ids are unique per execution, so one
// store serves every session in the process. The in-memory MCP session store
// and the local app both build on it.
// ---------------------------------------------------------------------------

import { Deferred, Effect } from "effect";

import type { ResumeResponse } from "@executor-js/execution";

import type { BrowserApprovalStore } from "./tool-server";

export interface InProcessBrowserApprovalStore {
  /** The store the MCP server awaits a decision on (browser elicitation mode). */
  readonly store: BrowserApprovalStore;
  /** Record a human's decision, waking any in-flight `waitForResponse`. */
  readonly recordResponse: (executionId: string, response: ResumeResponse) => Effect.Effect<void>;
  /** Drop a pending decision/waiter (e.g. when its session is torn down). */
  readonly forget: (executionId: string) => void;
}

export const makeInProcessBrowserApprovalStore = (): InProcessBrowserApprovalStore => {
  const responses = new Map<string, ResumeResponse>();
  const waiters = new Map<string, Deferred.Deferred<ResumeResponse>>();

  const take = (executionId: string): Effect.Effect<ResumeResponse | null> =>
    Effect.sync(() => {
      const response = responses.get(executionId) ?? null;
      if (response) responses.delete(executionId);
      return response;
    });

  const waitFor = (executionId: string): Effect.Effect<ResumeResponse | null> =>
    Effect.gen(function* () {
      const existing = yield* take(executionId);
      if (existing) return existing;

      const waiter = waiters.get(executionId) ?? (yield* Deferred.make<ResumeResponse>());
      waiters.set(executionId, waiter);
      yield* Deferred.await(waiter).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (waiters.get(executionId) === waiter) waiters.delete(executionId);
          }),
        ),
      );
      return yield* take(executionId);
    });

  return {
    store: { takeResponse: take, waitForResponse: waitFor },
    recordResponse: (executionId, response) =>
      Effect.gen(function* () {
        responses.set(executionId, response);
        const waiter = waiters.get(executionId);
        if (waiter) yield* Deferred.succeed(waiter, response);
      }),
    forget: (executionId) => {
      responses.delete(executionId);
      waiters.delete(executionId);
    },
  };
};
