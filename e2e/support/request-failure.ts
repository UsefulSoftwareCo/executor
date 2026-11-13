/**
 * How far a failed HTTP call got, so a failure that never produced a usable response can be told
 * apart from another: a refused or reset connection, a DNS or TLS failure, a socket closed while
 * the body was streaming, a body that is not JSON, or no answer before the deadline.
 *
 * It records only identifier-shaped facts: the stage, the response status once headers were read,
 * Cloudflare's `cf-ray` and edge location once headers were read (one ray names one request in
 * Cloudflare's logs), what the client saw when no answer completed (DNS, connect, TLS, a reset, a
 * closed socket or a time-out), the tags and names along the error's cause chain, the first
 * low-level error `code`, and the time the call ran. Never a URL, a header, a body or an error message: those can hold credentials, and
 * `failure-text.ts` gives a masked message where one is wanted.
 */
import { Clock, Duration, Effect, Option, Redacted, Result, Schema } from "effect";
import type { HttpClientError, HttpClientResponse } from "effect/http";
import { errorCode, nextCause } from "./failure-text.ts";

export const RequestStage = Schema.Literals([
  // No response headers arrived: connect, DNS, TLS, a reset before the answer, or a request
  // the client could not send.
  "before response",
  // Headers arrived with `status`; the body failed while it was read.
  "reading body",
  // The whole body arrived, and it is not the JSON the caller reads.
  "decoding body",
  // The deadline passed; `status` says whether headers had arrived.
  "timeout",
]);
export type RequestStage = typeof RequestStage.Type;

/**
 * What the client saw when the call did not complete: a name lookup that failed, a connection
 * that was refused or never made, a TLS handshake that failed, a connection reset or closed by
 * the other side, or no answer before a deadline. `other` is a transport failure with none of
 * those codes. A body that arrived whole but is not JSON has none.
 */
export const RequestConnection = Schema.Literals([
  "dns",
  "connect",
  "tls",
  "reset",
  "closed",
  "timeout",
  "other",
]);
export type RequestConnection = typeof RequestConnection.Type;

export const RequestFailure = Schema.Struct({
  stage: RequestStage,
  status: Schema.optional(Schema.Number),
  connection: Schema.optional(RequestConnection),
  /** Cloudflare's ray id from the response's `cf-ray` header, when one arrived. */
  ray: Schema.optional(Schema.String),
  /** The Cloudflare location that answered, the ray's suffix (`IAD`), when one arrived. */
  colo: Schema.optional(Schema.String),
  /** Tags and names along the cause chain, outermost first: `TransportError > TypeError > SocketError`. */
  errors: Schema.optional(Schema.String),
  /** The first low-level error code on the chain: `ECONNRESET`, `UND_ERR_SOCKET`, `ENOTFOUND`. */
  code: Schema.optional(Schema.String),
  elapsedMs: Schema.Number,
});
export type RequestFailure = typeof RequestFailure.Type;

// Names are identifiers set by code, never by data, and kept only in that shape.
const identifier = /^[A-Za-z][A-Za-z0-9]{0,39}$/u;
const depth = 8;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

/**
 * The tags and names on a cause chain and its first code. An Effect `HttpClientError` holds its
 * `reason` (`TransportError`, `DecodeError`, …); fetch's `TypeError` holds the socket error.
 */
export const causeChain = (cause: unknown): { errors?: string; code?: string } => {
  const errors: Array<string> = [];
  const code = errorCode(cause);
  let current: unknown = cause;
  for (let level = 0; level < depth && typeof current === "object" && current !== null; level++) {
    const tag = field(current, "_tag");
    const name = typeof tag === "string" ? tag : field(current, "name");
    if (typeof name === "string" && identifier.test(name) && errors.at(-1) !== name)
      errors.push(name);
    current = nextCause(current);
  }
  return {
    ...(errors.length > 0 && { errors: errors.join(" > ") }),
    ...(code !== undefined && { code }),
  };
};

// `cf-ray` is 16 hex digits and, on a response, a dash and the three-letter location.
const rayShape = /^([0-9a-f]{16})(?:-([A-Z]{3}))?$/u;

/** The ray and location of a response that came through Cloudflare. Anything else is not kept. */
export const edgeOf = (
  headers: Readonly<Record<string, string | undefined>> | undefined,
): { ray?: string; colo?: string } => {
  const [, ray, colo] = rayShape.exec(headers?.["cf-ray"]?.trim() ?? "") ?? [];
  if (ray === undefined) return {};
  return { ray, ...(colo !== undefined && { colo }) };
};

const connectionCodes: ReadonlyArray<readonly [RequestConnection, RegExp]> = [
  ["dns", /^(?:ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)$/u],
  [
    "connect",
    /^(?:ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/u,
  ],
  [
    "tls",
    /^(?:EPROTO|ERR_TLS_\w+|ERR_SSL_\w+|CERT_\w+|UNABLE_TO_\w+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/u,
  ],
  ["reset", /^(?:ECONNRESET|EPIPE)$/u],
  ["closed", /^(?:UND_ERR_SOCKET|UND_ERR_CLOSED|ECONNABORTED|ERR_STREAM_PREMATURE_CLOSE)$/u],
  ["timeout", /^(?:UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/u],
];

/** What the client saw, from the stage and the low-level code. A decoded body has none. */
export const connectionOf = (
  stage: RequestStage,
  code: string | undefined,
): RequestConnection | undefined => {
  if (stage === "decoding body") return undefined;
  if (stage === "timeout") return "timeout";
  if (code === undefined) return "other";
  return connectionCodes.find(([, pattern]) => pattern.test(code))?.[0] ?? "other";
};

/**
 * One line: `before response (reset), TransportError > TypeError > SocketError ECONNRESET, after
 * 412 ms`, with `ray 8f0c1a2b3c4d5e6f-IAD` when a response came through Cloudflare.
 */
export const requestFailureText = (failure: RequestFailure) =>
  [
    (failure.status === undefined
      ? failure.stage
      : failure.stage === "timeout"
        ? `timeout after the headers of HTTP ${failure.status}`
        : `${failure.stage} of HTTP ${failure.status}`) +
      (failure.connection === undefined || failure.connection === failure.stage
        ? ""
        : ` (${failure.connection})`),
    [failure.errors, failure.code].filter((part) => part !== undefined).join(" ") || undefined,
    `after ${failure.elapsedMs} ms`,
    failure.ray === undefined
      ? undefined
      : `ray ${failure.ray}${failure.colo === undefined ? "" : `-${failure.colo}`}`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");

/** A call that failed before its body could be read, with how far it got. */
export class CallFailed extends Schema.TaggedError<CallFailed>()("CallFailed", {
  failure: RequestFailure,
  /**
   * The raw transport error, kept redacted for `failure-text.ts` to give its masked text. A decode
   * failure has none: a parser's message quotes the body.
   */
  cause: Schema.optional(Schema.Redacted(Schema.Unknown)),
}) {}

/**
 * Run a request and read its whole body as text, within `timeout` when one is given. A failure
 * says which stage it reached; the caller decodes the text and reports a decode failure with
 * `decodeFailure` or `parseJson`.
 */
export const readResponse = <R>(
  execute: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, R>,
  timeout?: Duration.Input,
) =>
  Effect.suspend(() => {
    let status: number | undefined;
    let edge: { ray?: string; colo?: string } = {};
    return Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const fail = (stage: RequestStage, cause: unknown) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => {
            const chain = causeChain(cause);
            const connection = connectionOf(stage, chain.code);
            return Effect.fail(
              new CallFailed({
                failure: {
                  stage,
                  ...(status !== undefined && { status }),
                  ...(connection !== undefined && { connection }),
                  ...edge,
                  ...chain,
                  elapsedMs: now - started,
                },
                ...(cause !== undefined && { cause: Redacted.make(cause) }),
              }),
            );
          }),
        );
      const read = Effect.gen(function* () {
        const response = yield* execute.pipe(
          Effect.catch((cause) => fail("before response", cause)),
        );
        status = response.status;
        edge = edgeOf(response.headers);
        const text = yield* response.text.pipe(
          Effect.catch((cause) => fail("reading body", cause)),
        );
        return { response, text, started };
      });
      if (timeout === undefined) return yield* read;
      return yield* read.pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap(
          Option.match({
            onNone: () => fail("timeout", undefined),
            onSome: Effect.succeed,
          }),
        ),
      );
    });
  });

/** The failure of a body that arrived whole and is not JSON. */
export const decodeFailure = (
  status: number,
  started: number,
  cause: unknown,
  headers?: Readonly<Record<string, string | undefined>>,
) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now): RequestFailure => ({
      stage: "decoding body",
      status,
      ...edgeOf(headers),
      ...causeChain(cause),
      elapsedMs: now - started,
    })),
  );

/**
 * Parse a whole body as JSON. A body that is not JSON fails as a `decoding body` failure with the
 * parser's error name only: its message quotes the body, which can hold tokens and secrets, so the
 * parser's error is neither kept nor passed on as a cause.
 */
export const parseJson = (
  text: string,
  status: number,
  started: number,
  headers?: Readonly<Record<string, string | undefined>>,
) =>
  Effect.suspend(() => {
    // An empty body is no value, as before, not a decode failure.
    if (text === "") return Effect.succeed(null as unknown);
    const parsed = Result.try((): unknown => JSON.parse(text));
    return Result.isSuccess(parsed)
      ? Effect.succeed(parsed.success)
      : decodeFailure(status, started, parsed.failure, headers).pipe(
          Effect.flatMap((failure) => Effect.fail(new CallFailed({ failure }))),
        );
  });
