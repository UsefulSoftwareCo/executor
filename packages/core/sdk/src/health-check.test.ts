// Identity ranking heuristics: what leads in a rendered response, and which
// candidate call gets pre-seeded, are product behavior: email beats login
// beats display name beats id, and only singular paths make a call a whoami.
import { describe, expect, it } from "@effect/vitest";

import {
  candidateIdentityTier,
  rankResponseSample,
  sortHealthCheckCandidatesByIdentity,
} from "./health-check";

const row = (path: string, value: string) => ({ path, value });

describe("rankResponseSample", () => {
  it("puts identity fields first (email before login), rest in response order", () => {
    const ranked = rankResponseSample([
      row("createdAt", "2024-01-01"),
      row("login", "alice"),
      row("plan", "pro"),
      row("email", "alice@example.com"),
    ]);
    expect(ranked.map((r) => r.path)).toEqual(["email", "login", "createdAt", "plan"]);
  });

  it("is stable within a tier and for non-identity rows", () => {
    const ranked = rankResponseSample([
      row("a", "1"),
      row("b", "2"),
      row("user.email", "x@y.z"),
      row("account.email", "a@b.c"),
    ]);
    // Both emails are tier 0; original order preserved between them, and the
    // non-identity rows keep their relative order after.
    expect(ranked.map((r) => r.path)).toEqual(["user.email", "account.email", "a", "b"]);
  });
});

describe("candidateIdentityTier", () => {
  it("ignores identity keys under array segments (a collection's members, not the caller)", () => {
    const listAliases = {
      operation: "aliases.listAliases",
      method: "get",
      requiredArgCount: 0,
      destructive: false,
      responseFields: [
        { path: "aliases.0.creator.email", type: "string" },
        { path: "aliases.0.uid", type: "string" },
        { path: "pagination.count", type: "number" },
      ],
    };
    const getAuthUser = {
      operation: "user.getAuthUser",
      method: "get",
      requiredArgCount: 0,
      destructive: false,
      responseFields: [
        { path: "user.email", type: "string" },
        { path: "user.id", type: "string" },
      ],
    };
    expect(candidateIdentityTier(listAliases), "array-nested email does not count").toBe(-1);
    expect(candidateIdentityTier(getAuthUser), "singular email counts").toBe(0);
    expect(
      sortHealthCheckCandidatesByIdentity([listAliases, getAuthUser])[0]?.operation,
      "the whoami call ranks ahead of the list",
    ).toBe("user.getAuthUser");
  });
});
