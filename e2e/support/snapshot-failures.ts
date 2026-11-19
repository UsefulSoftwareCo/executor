/**
 * A scenario whose snapshot is missing or empty fails, as the runner writes none unless asked
 * (e2e/snapshot-updates.ts). Vitest's failure then shows no value, since there is nothing to
 * compare with, so this adds what the scenario produced and how to record it on purpose. A changed
 * snapshot already shows its diff.
 */
import { beforeEach } from "vitest";

const unrecorded = /^Snapshot `.+` mismatched$/u;

export const installSnapshotFailures = () =>
  beforeEach((context) => {
    context.onTestFailed(({ task }) => {
      for (const error of task.result?.errors ?? []) {
        if (!unrecorded.test(error.message) || error.expected !== undefined) continue;
        if (typeof error.actual !== "string") continue;
        const original = error.message;
        error.message = [
          `${original}: no snapshot is recorded, and this run records none.`,
          "The scenario produced:",
          error.actual,
          "Read it as an assertion. To record it, run this scenario alone with",
          "--test-name '<its title>' --update-snapshots, then read every line in git diff.",
        ].join("\n");
        if (error.stack) error.stack = error.stack.replace(original, error.message);
      }
    });
  });
