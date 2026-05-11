import { Cause, Effect, Option, Predicate, Result } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";

const MAX_LOGGED_CAUSE_CHARS = 4_000;

const truncate = (value: string): string =>
  value.length <= MAX_LOGGED_CAUSE_CHARS
    ? value
    : `${value.slice(0, MAX_LOGGED_CAUSE_CHARS)}\n...[truncated ${
        value.length - MAX_LOGGED_CAUSE_CHARS
      } chars]`;

const loggedCause = (cause: Cause.Cause<unknown>): string => truncate(Cause.pretty(cause));

const objectValue = (value: unknown, key: string): unknown =>
  Predicate.hasProperty(value, key) ? value[key] : undefined;

const numberValue = (value: unknown, key: string): number | undefined => {
  const field = objectValue(value, key);
  return typeof field === "number" ? field : undefined;
};

const stringValue = (value: unknown, key: string): string | undefined => {
  const field = objectValue(value, key);
  return typeof field === "string" ? field : undefined;
};

const firstFailureOrDefect = (cause: Cause.Cause<unknown>): unknown => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) return failure.value;

  const defect = Cause.findDefect(cause);
  if (Result.isSuccess(defect)) return defect.success;

  return undefined;
};

const errorTag = (error: unknown): string => stringValue(error, "_tag") ?? "Unknown";

const httpStatus = (error: unknown): number => {
  const directStatus = numberValue(error, "status");
  if (directStatus) return directStatus;

  const constructor = objectValue(error, "constructor");
  const ast = objectValue(constructor, "ast");
  const annotations = objectValue(ast, "annotations");
  return numberValue(annotations, "httpApiStatus") ?? 500;
};

const requestPath = (request: HttpServerRequest.HttpServerRequest): string => {
  if (URL.canParse(request.url, "http://executor.local")) {
    return new URL(request.url, "http://executor.local").pathname;
  }

  return request.url.split("?")[0] ?? request.url;
};

export const logApiErrorCause = (
  request: HttpServerRequest.HttpServerRequest,
  cause: Cause.Cause<unknown>,
): void => {
  const error = firstFailureOrDefect(cause);
  console.error("[api] request failed", {
    method: request.method,
    path: requestPath(request),
    status: httpStatus(error),
    errorTag: errorTag(error),
    cause: loggedCause(cause),
  });
};

export const ApiErrorLoggingLive = HttpRouter.middleware()((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* httpEffect.pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          logApiErrorCause(request, cause);
        }),
      ),
    );
  }),
).layer;
