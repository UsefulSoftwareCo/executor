// ---------------------------------------------------------------------------
// Cloud-app implementation of the shared `ErrorCapture` service. This is the
// only file in the cloud-app that imports `@sentry/cloudflare` for error
// capture — handlers, plugin SDKs, and storage code all stay
// Sentry-agnostic and request the `ErrorCapture` tag instead.
//
// `withObservability` (in @executor-js/api) wraps every handler effect; when
// it sees an unmapped cause it asks `ErrorCapture.captureException` for a
// trace id and fails with `InternalError({ traceId })`. The client gets
// the opaque id, we get the full cause + stack in Sentry.
// ---------------------------------------------------------------------------

import * as Sentry from "@sentry/cloudflare";
import { Cause, Effect, Layer } from "effect";

import { ErrorCapture } from "@executor-js/api";

// Drizzle/postgres-js include the failing SQL (params + bound values) in
// their error message. For OpenAPI source inserts that's 1MB+ of spec
// text which blows past terminal scrollback and hides the actual pg
// error. Sentry still receives the full, untruncated cause via
// `setExtra`; only the dev-console mirror is capped.
const MAX_CONSOLE_CAUSE_CHARS = 4_000;

const truncate = (s: string): string =>
  s.length <= MAX_CONSOLE_CAUSE_CHARS
    ? s
    : `${s.slice(0, MAX_CONSOLE_CAUSE_CHARS)}\n…[truncated ${s.length - MAX_CONSOLE_CAUSE_CHARS} chars]`;

// Sentry's `captureException` can't serialize Effect's `CauseImpl` (it logs
// `'CauseImpl' captured as exception with keys: reasons, ~effect/Cause` and
// drops the real failure). `Cause.squash` isn't enough on its own: when an
// inner `runPromise` rejects with a CauseImpl from its own `causeSquash`
// (Effect v4's behaviour), `Effect.promise` re-wraps it as `Die(causeImpl)`,
// and `Cause.squash(outer)` then hands the CauseImpl straight back. Use
// `Cause.prettyErrors` instead — it always produces real `Error` instances,
// even for non-Error defects (including a CauseImpl defect, which gets
// wrapped via `causePrettyMessage`).
export const sentryPayloadForCause = (
  input: unknown,
): { primary: unknown; pretty: string | null } => {
  if (Cause.isCause(input)) {
    const pretty = Cause.pretty(input);
    const errors = Cause.prettyErrors(input);
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: Sentry captureException needs an Error-like primary payload for pretty Effect causes
    return { primary: errors[0] ?? new Error(pretty), pretty };
  }
  return { primary: input, pretty: null };
};

export const captureCause = (input: unknown): string | undefined => {
  const { primary, pretty } = sentryPayloadForCause(input);
  return Sentry.captureException(primary, (scope) => {
    if (pretty !== null) scope.setExtra("cause", pretty);
    return scope;
  });
};

export const ErrorCaptureLive: Layer.Layer<ErrorCapture> = Layer.succeed(
  ErrorCapture,
  ErrorCapture.of({
    captureException: (cause) =>
      Effect.sync(() => {
        console.error("[api] unhandled cause:", truncate(Cause.pretty(cause)));
        return captureCause(cause) ?? "";
      }),
  }),
);
