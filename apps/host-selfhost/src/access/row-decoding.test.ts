import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { ApplicationRow, SessionRow, TokenRow } from "./handlers";

// Production regression: Better Auth omits empty columns, so a row can arrive
// WITHOUT a key the schema called nullable. Under Effect v4 `NullishOr` that
// failed the whole Connected clients list ("Unreadable rows (session)") on a
// live instance whose sessions had no recorded IP. Absent keys must decode.

const decodeSession = Schema.decodeUnknownOption(SessionRow);
const decodeToken = Schema.decodeUnknownOption(TokenRow);
const decodeApplication = Schema.decodeUnknownOption(ApplicationRow);

describe("connected-clients row decoding", () => {
  it("accepts a session with no ipAddress or userAgent key", () => {
    expect(Option.isSome(decodeSession({ id: "s1", token: "t1", createdAt: new Date() }))).toBe(
      true,
    );
  });

  it("accepts timestamps as Date, ISO string or epoch ms", () => {
    for (const at of [new Date(), "2026-09-13T02:01:29.143Z", 1789819423837]) {
      const row = { id: "s", token: "t", createdAt: at, updatedAt: at, expiresAt: at };
      expect(Option.isSome(decodeSession(row))).toBe(true);
    }
  });

  it("accepts an OAuth token and application with their optional fields absent", () => {
    expect(Option.isSome(decodeToken({ clientId: "c1" }))).toBe(true);
    expect(Option.isSome(decodeApplication({ clientId: "c1" }))).toBe(true);
  });

  it("still refuses a row without its identity", () => {
    expect(Option.isNone(decodeSession({ token: "t" }))).toBe(true);
    expect(Option.isNone(decodeToken({ createdAt: new Date() }))).toBe(true);
  });
});
