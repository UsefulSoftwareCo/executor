export const failureCases = {
  unanswered: "A request that never answers is kept with older unanswered ones",
  innerScope: "A failure is kept with the cleanup of its inner scope",
  sameMillisecond: "A failure is kept with the cleanup in its millisecond",
  nestedSteps: "A failure after a nested step keeps the enclosing step's requests",
  timeout: "A case that times out keeps the requests before its deadline",
  nearDeadline: "A failure just before the deadline keeps its own error while traces arrive",
  passing: "A passing case keeps only its slowest traces and does not wait",
  answeredAfterRefused: "A request answered after sixteen newer refused ones is kept",
  retriedStep: "A retried step that fails with the same error keeps both attempts",
  reusedPrimitive: "A failure that reuses a recovered step's primitive error keeps its requests",
  repeatedInterruption: "A second interruption by the same fiber keeps its requests",
  cleanupInStep: "A failure is kept with the cleanup inside its step",
  failedAcquire: "A failed acquireRelease acquisition is kept with the scope's later cleanup",
  backgroundAfterFailure: "A failing request is kept with background requests sent after it",
  failedCaseCleanup: "A case whose own cleanup fails is failed and keeps the failing request",
  overBudget: "A failed case over its trace budget leaves out its oldest traces",
  slowCollector: "A failed case whose traces are slow to read stops at its deadline",
} as const;

export const probePath = (role: string) => `/api/evidence-probe/${role}`;

export const caseDeadlineMs = 6_000;

export const smallTraceBudget = 12_000;

export const slowTraceRead = { delayMs: 2_000, requests: 1_200 } as const;
