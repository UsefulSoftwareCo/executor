import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";

const Identity = Schema.Struct({
  userId: Schema.String,
  organizationId: Schema.String,
  organizationSlug: Schema.NullOr(Schema.String),
  role: Schema.Literals(["admin", "member", "owner"]),
});
const bridgeKey = "synthetic-coexistence-e2e-key-32-characters";

scenario(
  "cloud coexistence identity verifies sessions and denies foreign organizations",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const first = yield* target.newIdentity();
    const second = yield* target.newIdentity();
    const read = (query: string, headers: Record<string, string> = {}) =>
      Effect.promise(() => fetch(`${target.baseUrl}/__coexistence/identity?${query}`, { headers }));
    expect((yield* read("kind=browser", first.headers)).status).toBe(404);
    expect(
      (yield* read("kind=browser", { ...first.headers, "x-executor-coexistence-key": "wrong" }))
        .status,
    ).toBe(404);
    expect((yield* read("kind=browser", { "x-executor-coexistence-key": bridgeKey })).status).toBe(
      401,
    );
    const firstReply = yield* read("kind=browser", {
      ...first.headers,
      "x-executor-coexistence-key": bridgeKey,
    });
    expect(firstReply.status).toBe(200);
    const firstIdentity = yield* Effect.promise(() => firstReply.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Identity)),
    );
    expect(firstIdentity).toMatchObject({ role: "admin" });
    expect(Object.keys(firstIdentity).sort()).toEqual([
      "organizationId",
      "organizationSlug",
      "role",
      "userId",
    ]);
    const mcp = yield* Mcp;
    const bearer = yield* mcp.mintBearer(first.credentials?.email ?? first.label);
    const authorized = yield* read(
      `kind=mcp&organization=${encodeURIComponent(firstIdentity.organizationId)}`,
      { authorization: `Bearer ${bearer}`, "x-executor-coexistence-key": bridgeKey },
    );
    expect(authorized.status).toBe(200);
    const mcpIdentity = yield* Effect.promise(() => authorized.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Identity)),
    );
    expect(mcpIdentity).toEqual(firstIdentity);
    const secondReply = yield* read("kind=browser", {
      ...second.headers,
      "x-executor-coexistence-key": bridgeKey,
    });
    expect(secondReply.status).toBe(200);
    const secondIdentity = yield* Effect.promise(() => secondReply.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Identity)),
    );
    expect(
      (yield* read(
        `kind=browser&organization=${encodeURIComponent(secondIdentity.organizationId)}`,
        { ...first.headers, "x-executor-coexistence-key": bridgeKey },
      )).status,
    ).toBe(403);
    expect(
      (yield* read("kind=mcp", { ...first.headers, "x-executor-coexistence-key": bridgeKey }))
        .status,
    ).toBe(401);
  }),
);
