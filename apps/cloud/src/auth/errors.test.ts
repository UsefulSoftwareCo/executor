// The WorkOS failure-classification boundary: the service adapter must thread
// the SDK exception's HTTP status onto the public `WorkOSError`, and the
// definitive-denial predicate must split 401/403/404 (WorkOS answered "no" —
// fail closed) from 429/5xx/no-status (transient — retryable). This split is
// what keeps a WorkOS blip from condemning MCP sessions AND a revoked key from
// being mistaken for a blip.
import { describe, expect, it } from "@effect/vitest";
import {
  GenericServerException,
  NotFoundException,
  RateLimitExceededException,
  UnauthorizedException,
} from "@workos-inc/node/worker";

import {
  ServiceAdapterError,
  isDefinitiveWorkOSDenial,
  isDefinitiveWorkOSDenialStatus,
  workosErrorFromFailure,
} from "./errors";

describe("workosErrorFromFailure", () => {
  it("reads the status off the real SDK exceptions through the adapter wrapper", () => {
    const cases: ReadonlyArray<readonly [unknown, number]> = [
      [new UnauthorizedException("req_1"), 401],
      [
        new NotFoundException({ code: "not_found", message: "gone", path: "/x", requestID: "r" }),
        404,
      ],
      [new RateLimitExceededException("slow down", "req_2", 1), 429],
      [new GenericServerException(503, "upstream", {}, "req_3"), 503],
    ];
    for (const [sdkError, status] of cases) {
      const wrapped = workosErrorFromFailure(new ServiceAdapterError({ cause: sdkError }));
      expect(wrapped.status, `status for ${String(sdkError)}`).toBe(status);
    }
  });

  it("leaves status unset for non-HTTP failures (network error, timeout)", () => {
    // The shape fetch/undici raise on a network failure: an error value with a
    // message and no HTTP status (statusless by construction, unlike the SDK's
    // typed HTTP exceptions).
    const networkFailure: unknown = { name: "TypeError", message: "fetch failed" };
    const wrapped = workosErrorFromFailure(new ServiceAdapterError({ cause: networkFailure }));
    expect(wrapped.status).toBeUndefined();
  });
});

describe("isDefinitiveWorkOSDenial", () => {
  it("treats 401/403/404 as definitive and everything else as transient", () => {
    expect(isDefinitiveWorkOSDenialStatus(401)).toBe(true);
    expect(isDefinitiveWorkOSDenialStatus(403)).toBe(true);
    expect(isDefinitiveWorkOSDenialStatus(404)).toBe(true);
    expect(isDefinitiveWorkOSDenialStatus(429)).toBe(false);
    expect(isDefinitiveWorkOSDenialStatus(500)).toBe(false);
    expect(isDefinitiveWorkOSDenialStatus(503)).toBe(false);
    expect(isDefinitiveWorkOSDenialStatus(undefined)).toBe(false);
  });

  it("only claims WorkOSError instances, never arbitrary errors with a status", () => {
    expect(isDefinitiveWorkOSDenial({ status: 403 })).toBe(false);
    expect(
      isDefinitiveWorkOSDenial(
        workosErrorFromFailure(new ServiceAdapterError({ cause: new UnauthorizedException("r") })),
      ),
    ).toBe(true);
  });
});
