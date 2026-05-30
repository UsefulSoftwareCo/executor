// ---------------------------------------------------------------------------
// Console `ErrorCapture` factory.
//
// Prints the squashed + pretty-printed structured cause to stderr and returns
// a short correlation id that surfaces in the opaque 500 traceId, so operators
// can grep their logs/terminal scrollback when a user reports a traceId. Hosts
// that want richer reporting (cloud: Sentry) swap in their own adapter behind
// the same `ErrorCapture` tag.
//
// The `prefix` distinguishes which host emitted the id (e.g. `selfhost`,
// `local`).
// ---------------------------------------------------------------------------

import { Cause, Effect, Layer } from "effect";

import { ErrorCapture } from "../observability";

export const consoleErrorCapture = (prefix: string): Layer.Layer<ErrorCapture> => {
  const nextTraceId = () =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return Layer.succeed(
    ErrorCapture,
    ErrorCapture.of({
      captureException: (cause) =>
        Effect.sync(() => {
          const traceId = nextTraceId();
          const squashed = Cause.squash(cause);
          console.error(
            `[executor ${traceId}]`,
            // oxlint-disable-next-line executor/no-instanceof-error -- boundary: console logger preserves native Error stack output
            squashed instanceof Error ? (squashed.stack ?? squashed) : squashed,
          );
          console.error(`[executor ${traceId}] cause:`, Cause.pretty(cause));
          return traceId;
        }),
    }),
  );
};
