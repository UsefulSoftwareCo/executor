/** Requests the browser could not complete because no response reached it. */
import { Cause } from "effect";
import { HttpClientError } from "effect/http";
import { UnexpectedError, UserFacingError } from "./user-facing-error.ts";

/**
 * Fetch rejects with a `TypeError` when no response arrives: the device is offline, the page
 * navigated away first, the connection was reset before a response, or the browser blocked the
 * request. The server may still have completed the request and records its own outcome. Failures Executor constructs itself, such as a batch reply
 * that ended without an answer, carry no such cause and stay unexpected.
 */
export const isConnectionFailure = (error: unknown): error is HttpClientError.HttpClientError =>
  HttpClientError.isHttpClientError(error) &&
  error.reason._tag === "TransportError" &&
  error.reason.cause instanceof TypeError;

/** Typed API clients may surface a lost connection as a failure or, after narrowing, a defect. */
export const hasConnectionFailure = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) =>
      (Cause.isFailReason(reason) && isConnectionFailure(reason.error)) ||
      (Cause.isDieReason(reason) && isConnectionFailure(reason.defect)),
  );

/** The browser could not reach Executor. Nothing on the server needs fixing. */
export const ConnectionFailed = UserFacingError.define({
  tag: "ConnectionFailed",
  // Never served: the browser constructs it when no response arrived.
  status: 503,
  title: "Can’t reach Executor",
  description: "Your browser did not get a response from Executor.",
  recovery: {
    action: "Check your internet connection, then try again.",
    instructions:
      "The browser received no response from Executor. Check the device’s network connection, VPN, proxy or browser extensions that block requests, then retry the operation.",
  },
  retryable: true,
  agentFixable: false,
});
export type ConnectionFailed = typeof ConnectionFailed.Type;

/** What to show for a failure no contract declares: a lost connection, or an unexpected error. */
export const undeclaredError = (cause: Cause.Cause<unknown>): UserFacingError =>
  hasConnectionFailure(cause) ? new ConnectionFailed() : new UnexpectedError();
