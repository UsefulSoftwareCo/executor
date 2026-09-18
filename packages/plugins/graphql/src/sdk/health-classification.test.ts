// The prose a transport failure carries is the operating system's or the HTTP
// client's, not the upstream's verdict on a credential. Reading it as one sent
// users to re-enter a secret that was never the problem: `EACCES: permission
// denied` on a socket matches any pattern looking for the word "permission".

import { describe, expect, it } from "@effect/vitest";

import { GraphqlIntrospectionError } from "./errors";
import { healthFromIntrospectionError } from "./plugin";

const classify = (input: {
  readonly reason?: "network" | "graphql-errors" | "invalid-json";
  readonly status?: number;
  readonly upstreamMessage?: string;
}) =>
  healthFromIntrospectionError(
    new GraphqlIntrospectionError({
      message: "introspection failed",
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.upstreamMessage === undefined ? {} : { upstreamMessage: input.upstreamMessage }),
    }),
    Date.now(),
  );

describe("GraphQL liveness classification", () => {
  it("does not read a transport failure's prose as a dead credential", () => {
    const verdict = classify({
      reason: "network",
      upstreamMessage: "connect EACCES: permission denied /run/graphql.sock",
    });
    expect(verdict.status).not.toBe("expired");
  });

  it("still reads an authentication failure the upstream named as expired", () => {
    const verdict = classify({
      reason: "graphql-errors",
      upstreamMessage: "Authentication required: invalid token",
    });
    expect(verdict.status).toBe("expired");
  });

  it("classifies an HTTP 401 on its status whatever else is said", () => {
    const verdict = classify({ status: 401, upstreamMessage: "nope" });
    expect(verdict.status).toBe("expired");
    expect(verdict.httpStatus).toBe(401);
  });
});
