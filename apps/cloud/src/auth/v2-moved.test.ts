import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { v2ImportAnswer, v2McpOrigin, type V2ImportSource } from "./v2-import";
import {
  liveV2MovedSource,
  parseV2Moved,
  v2Moved,
  V2_MOVED_AT_KEY,
  V2_MOVED_SLUG_KEY,
  type V2MovedSource,
} from "./v2-moved";
import { WorkOSClient, type WorkOSClientService } from "./workos";
import { WorkOSError } from "./errors";

const USER = "user_signed_in";
const ORG = "org_example";
const V2_ORIGIN = new URL("https://app.example.test");
const V2_MCP_ORIGIN = new URL("https://mcp.example.test");
const MOVED_AT = "2026-10-09T17:30:00.000Z";

const movedMetadata = (overrides: Record<string, unknown> = {}) => ({
  [V2_MOVED_SLUG_KEY]: "example-team",
  [V2_MOVED_AT_KEY]: MOVED_AT,
  ...overrides,
});

describe("v2 moved metadata", () => {
  it("reads the v2 slug and move time into the org's v2 page", () => {
    expect(parseV2Moved(movedMetadata(), V2_ORIGIN, null)).toEqual({
      v2Url: "https://app.example.test/org/example-team",
      v2Slug: "example-team",
      movedAt: MOVED_AT,
    });
  });

  it("adds v2's OAuth MCP server, not the org-pinned path, when v2's MCP origin is known", () => {
    expect(parseV2Moved(movedMetadata(), V2_ORIGIN, V2_MCP_ORIGIN)?.v2McpUrl).toBe(
      "https://mcp.example.test/mcp",
    );
  });

  it("ignores unrelated metadata keys", () => {
    expect(parseV2Moved(movedMetadata({ plan_note: "anything" }), V2_ORIGIN, null)?.v2Slug).toBe(
      "example-team",
    );
  });

  it("normalizes a timestamp with an offset to UTC", () => {
    expect(
      parseV2Moved(
        movedMetadata({ [V2_MOVED_AT_KEY]: "2026-10-09T10:30:00-07:00" }),
        V2_ORIGIN,
        null,
      )?.movedAt,
    ).toBe(MOVED_AT);
  });

  it("is not moved without both keys", () => {
    expect(parseV2Moved({}, V2_ORIGIN, null)).toBeNull();
    expect(parseV2Moved({ [V2_MOVED_SLUG_KEY]: "example-team" }, V2_ORIGIN, null)).toBeNull();
    expect(parseV2Moved({ [V2_MOVED_AT_KEY]: MOVED_AT }, V2_ORIGIN, null)).toBeNull();
  });

  it("is not moved when the slug is not a v2 slug", () => {
    for (const slug of [
      "",
      "Example-Team",
      "example_team",
      "-example",
      "example-",
      "example--team",
      "example/team",
      "../admin",
      "example team",
      "a".repeat(46),
      42,
      null,
    ]) {
      expect(
        parseV2Moved(movedMetadata({ [V2_MOVED_SLUG_KEY]: slug }), V2_ORIGIN, null),
        String(slug),
      ).toBeNull();
    }
    expect(
      parseV2Moved(movedMetadata({ [V2_MOVED_SLUG_KEY]: "a".repeat(45) }), V2_ORIGIN, null),
      "45 characters is v2's longest slug",
    ).not.toBeNull();
  });

  it("is not moved when the move time is not an ISO timestamp", () => {
    for (const movedAt of [
      "",
      "2026-10-09",
      "2026-10-09T17:30:00",
      "October 9, 2026",
      "2026-13-40T99:99:00Z",
      "1791000000000",
      1791000000000,
      null,
    ]) {
      expect(
        parseV2Moved(movedMetadata({ [V2_MOVED_AT_KEY]: movedAt }), V2_ORIGIN, null),
        String(movedAt),
      ).toBeNull();
    }
  });
});

/** A metadata read answering `metadata`, or failing; records each read. */
const movedSourceOf = (metadata: Record<string, unknown> | "unavailable") => {
  const reads: string[] = [];
  const source: V2MovedSource = {
    organizationMetadata: (organizationId) =>
      Effect.suspend(() => {
        reads.push(organizationId);
        return metadata === "unavailable" ? Effect.fail("unavailable") : Effect.succeed(metadata);
      }),
  };
  return { source, reads };
};

/** An import source that admits the user, recording whether it was asked. */
const importSourceOf = (eligible: boolean) => {
  const reads: string[] = [];
  const source: V2ImportSource = {
    emailVerified: () => Effect.sync(() => (reads.push("user"), true)),
    activeMemberIds: () => Effect.sync(() => (reads.push("members"), eligible ? [USER] : [])),
    subscriptions: () => Effect.sync(() => (reads.push("billing"), [])),
  };
  return { source, reads };
};

describe("v2 moved read", () => {
  it.effect("reads the selected org's metadata", () =>
    Effect.gen(function* () {
      const { source, reads } = movedSourceOf(movedMetadata());
      expect((yield* v2Moved(source, ORG, V2_ORIGIN, null))?.v2Slug).toBe("example-team");
      expect(reads).toEqual([ORG]);
    }),
  );

  it.effect("is not moved when the read fails", () =>
    Effect.gen(function* () {
      const { source } = movedSourceOf("unavailable");
      expect(yield* v2Moved(source, ORG, V2_ORIGIN, null)).toBeNull();
    }),
  );
});

describe("v2 moved live read", () => {
  /** WorkOS answering `getOrganization` with `answer`; every other call dies. */
  const workosAnswering = (answer: (organizationId: string) => Effect.Effect<unknown, unknown>) =>
    Layer.succeed(
      WorkOSClient,
      new Proxy({} as WorkOSClientService, {
        get: (_target, prop) =>
          prop === "getOrganization"
            ? answer
            : () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`),
      }),
    );

  const organization = (metadata: Record<string, string>) => ({
    object: "organization",
    id: ORG,
    name: "Example Org",
    allowProfilesOutsideOrganization: false,
    domains: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    externalId: null,
    metadata,
  });

  const movedLive = (layer: Layer.Layer<WorkOSClient>) =>
    Effect.gen(function* () {
      return yield* v2Moved(yield* liveV2MovedSource, ORG, V2_ORIGIN, null);
    }).pipe(Effect.provide(layer));

  it.effect("reads the move from the WorkOS organization's metadata", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const moved = yield* movedLive(
        workosAnswering((organizationId) =>
          Effect.sync(() => (asked.push(organizationId), organization(movedMetadata()))),
        ),
      );
      expect(moved?.v2Url).toBe("https://app.example.test/org/example-team");
      expect(asked).toEqual([ORG]);
    }),
  );

  it.effect("is not moved for an organization without the keys", () =>
    Effect.gen(function* () {
      expect(yield* movedLive(workosAnswering(() => Effect.succeed(organization({}))))).toBeNull();
    }),
  );

  it.effect("is not moved when WorkOS fails", () =>
    Effect.gen(function* () {
      const failure = new WorkOSError({ status: 503 });
      expect(yield* movedLive(workosAnswering(() => Effect.fail(failure)))).toBeNull();
    }),
  );
});

describe("v2 import answer", () => {
  const configured = {
    V2: { fetch: () => Promise.resolve(new Response(null)) },
    V2_SIGN_UP_URL: "https://app.example.test/login?mode=signup",
    V2_OAUTH_STATE_PREFIX: "x2.",
    V2_ANALYTICS_PROXY_PATH: "/api/0123456789abcdef",
    V2_ERROR_TUNNEL_PATH: "/api/fedcba9876543210/submit",
  };

  const answer = (
    env:
      | typeof configured
      | (typeof configured & { V2_MCP_ORIGIN: string })
      | Record<string, never>,
    moved: ReturnType<typeof movedSourceOf>,
    importing: ReturnType<typeof importSourceOf>,
  ) =>
    v2ImportAnswer({
      env,
      importSource: Effect.succeed(importing.source),
      movedSource: Effect.succeed(moved.source),
      userId: USER,
      organizationId: ORG,
    });

  it.effect("answers where a moved org lives, without offering the import again", () =>
    Effect.gen(function* () {
      const moved = movedSourceOf(movedMetadata());
      const importing = importSourceOf(true);
      expect(yield* answer(configured, moved, importing)).toEqual({
        url: null,
        moved: {
          v2Url: "https://app.example.test/org/example-team",
          v2Slug: "example-team",
          movedAt: MOVED_AT,
        },
      });
      expect(importing.reads, "a moved org's eligibility is never read").toEqual([]);
    }),
  );

  it.effect("adds v2's MCP server when V2_MCP_ORIGIN is set", () =>
    Effect.gen(function* () {
      const result = yield* answer(
        { ...configured, V2_MCP_ORIGIN: "https://mcp.example.test" },
        movedSourceOf(movedMetadata()),
        importSourceOf(true),
      );
      expect(result.moved?.v2McpUrl).toBe("https://mcp.example.test/mcp");
    }),
  );

  it.effect("offers the import to an eligible org that has not moved", () =>
    Effect.gen(function* () {
      expect(yield* answer(configured, movedSourceOf({}), importSourceOf(true))).toEqual({
        url: "https://app.example.test/v1-import",
        moved: null,
      });
      expect(yield* answer(configured, movedSourceOf({}), importSourceOf(false))).toEqual({
        url: null,
        moved: null,
      });
    }),
  );

  it.effect("treats malformed or unreadable metadata as not moved", () =>
    Effect.gen(function* () {
      for (const moved of [
        movedSourceOf(movedMetadata({ [V2_MOVED_SLUG_KEY]: "Not A Slug" })),
        movedSourceOf(movedMetadata({ [V2_MOVED_AT_KEY]: "yesterday" })),
        movedSourceOf("unavailable"),
      ]) {
        expect(yield* answer(configured, moved, importSourceOf(true))).toEqual({
          url: "https://app.example.test/v1-import",
          moved: null,
        });
      }
    }),
  );

  it.effect("answers nothing without a v2 host, without reading anything", () =>
    Effect.gen(function* () {
      const moved = movedSourceOf(movedMetadata());
      const importing = importSourceOf(true);
      expect(yield* answer({}, moved, importing)).toEqual({ url: null, moved: null });
      expect(moved.reads).toEqual([]);
      expect(importing.reads).toEqual([]);
    }),
  );
});

describe("v2 MCP origin", () => {
  it("reads a bare http(s) origin", () => {
    expect(v2McpOrigin({ V2_MCP_ORIGIN: "https://mcp.example.test" })?.href).toBe(
      "https://mcp.example.test/",
    );
    expect(v2McpOrigin({ V2_MCP_ORIGIN: "https://mcp.example.test/" })?.href).toBe(
      "https://mcp.example.test/",
    );
  });

  it("is unknown when unset or not a bare origin", () => {
    for (const value of [
      undefined,
      "",
      "mcp.example.test",
      "/mcp",
      "javascript:alert(1)",
      "https://mcp.example.test/mcp",
      "https://mcp.example.test/?x=1",
    ]) {
      expect(v2McpOrigin({ V2_MCP_ORIGIN: value }), String(value)).toBeNull();
    }
  });
});
