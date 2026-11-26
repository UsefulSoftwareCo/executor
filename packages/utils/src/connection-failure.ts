import { Cause } from "effect";
import { HttpClientError } from "effect/http";
import { UnexpectedError, UserFacingError } from "./user-facing-error.ts";

export const isConnectionFailure = (error: unknown): error is HttpClientError.HttpClientError =>
  HttpClientError.isHttpClientError(error) &&
  error.reason._tag === "TransportError" &&
  error.reason.cause instanceof TypeError;

export const hasConnectionFailure = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) =>
      (Cause.isFailReason(reason) && isConnectionFailure(reason.error)) ||
      (Cause.isDieReason(reason) && isConnectionFailure(reason.defect)),
  );

export const ConnectionFailed = UserFacingError.define({
  tag: "ConnectionFailed",
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

export const undeclaredError = (cause: Cause.Cause<unknown>): UserFacingError =>
  hasConnectionFailure(cause) ? new ConnectionFailed() : new UnexpectedError();
