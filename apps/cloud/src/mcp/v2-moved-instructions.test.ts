import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import { V2_MOVED_AT_KEY, V2_MOVED_SLUG_KEY } from "../auth/v2-moved";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { WorkOSError } from "../auth/errors";
import {
  V2_MOVED_READ_TIMEOUT_MS,
  mustReinitializeForV2Move,
  v2MovedInstructionsText,
  v2MovedMcpInstructions,
} from "./v2-moved-instructions";

const ORG = "org_example";

const env = {
  V2: { fetch: () => Promise.resolve(new Response(null)) },
  V2_SIGN_UP_URL: "https://app.example.test/login?mode=signup",
  V2_OAUTH_STATE_PREFIX: "x2.",
  V2_ANALYTICS_PROXY_PATH: "/api/0123456789abcdef",
  V2_ERROR_TUNNEL_PATH: "/api/fedcba9876543210/submit",
  V2_MCP_ORIGIN: "https://mcp.example.test",
};

const EXPECTED =
  "This organization moved to Executor v2 on October 9, 2026. " +
  "Its MCP server is now https://mcp.example.test/mcp; ask the user to reconnect their agent there " +
  "and choose the example-team organization when signing in. " +
  "Changes made through this server won't reach v2.";

const workosAnswering = (answer: () => Effect.Effect<unknown, unknown>) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) =>
        prop === "getOrganization"
          ? answer
          : () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`),
    }),
  );

const organization = (metadata: Record<string, string>) => ({ id: ORG, metadata });

const moved = organization({
  [V2_MOVED_SLUG_KEY]: "example-team",
  [V2_MOVED_AT_KEY]: "2026-10-09T12:00:00.000Z",
});

describe("v2 moved MCP instructions", () => {
  it("names the move date and the org's v2 MCP server", () => {
    expect(
      v2MovedInstructionsText({
        v2Url: "https://app.example.test/org/example-team",
        v2Slug: "example-team",
        movedAt: "2026-10-09T12:00:00.000Z",
        v2McpUrl: "https://mcp.example.test/mcp",
      }),
    ).toBe(EXPECTED);
  });

  it("says nothing without a v2 MCP URL", () => {
    expect(
      v2MovedInstructionsText({
        v2Url: "https://app.example.test/org/example-team",
        v2Slug: "example-team",
        movedAt: "2026-10-09T12:00:00.000Z",
      }),
    ).toBeNull();
  });

  it.effect("reads a moved org's instructions from WorkOS", () =>
    Effect.gen(function* () {
      expect(yield* v2MovedMcpInstructions(env, ORG)).toBe(EXPECTED);
    }).pipe(Effect.provide(workosAnswering(() => Effect.succeed(moved)))),
  );

  it.effect("gives none to an org that has not moved", () =>
    Effect.gen(function* () {
      expect(yield* v2MovedMcpInstructions(env, ORG)).toBeUndefined();
    }).pipe(Effect.provide(workosAnswering(() => Effect.succeed(organization({}))))),
  );

  it.effect("gives none, without reading WorkOS, when V2_MCP_ORIGIN is unset", () =>
    Effect.gen(function* () {
      const { V2_MCP_ORIGIN: _unset, ...withoutMcp } = env;
      expect(yield* v2MovedMcpInstructions(withoutMcp, ORG)).toBeUndefined();
    }).pipe(Effect.provide(workosAnswering(() => Effect.die("WorkOS was read")))),
  );

  it.effect("gives none when WorkOS fails", () =>
    Effect.gen(function* () {
      expect(yield* v2MovedMcpInstructions(env, ORG)).toBeUndefined();
    }).pipe(Effect.provide(workosAnswering(() => Effect.fail(new WorkOSError({ status: 503 }))))),
  );

  it.effect("gives up on a slow WorkOS instead of stalling the session", () =>
    Effect.gen(function* () {
      const read = yield* Effect.forkChild(v2MovedMcpInstructions(env, ORG));
      yield* TestClock.adjust(`${V2_MOVED_READ_TIMEOUT_MS} millis`);
      expect(yield* Fiber.join(read)).toBeUndefined();
    }).pipe(Effect.provide(workosAnswering(() => Effect.never))),
  );
});

describe("re-initializing a session for the v2 move", () => {
  it("re-initializes a client that got no notice once the org has moved", () => {
    expect(mustReinitializeForV2Move(undefined, EXPECTED)).toBe(true);
  });

  it("re-initializes a client whose notice is out of date", () => {
    expect(
      mustReinitializeForV2Move(EXPECTED.replace("example-team", "other-team"), EXPECTED),
    ).toBe(true);
  });

  it("leaves a client that got the current notice alone", () => {
    expect(mustReinitializeForV2Move(EXPECTED, EXPECTED)).toBe(false);
  });

  it("leaves a client alone when the org has not moved or the read failed", () => {
    expect(mustReinitializeForV2Move(undefined, undefined)).toBe(false);
    expect(mustReinitializeForV2Move(EXPECTED, undefined)).toBe(false);
  });
});
