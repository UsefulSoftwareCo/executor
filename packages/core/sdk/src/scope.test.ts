import { describe, expect, it } from "@effect/vitest";

import { makeUserOrgScopeStack, parseUserOrgScopeId, userOrgScopeId } from "./scope";

// The exact regex the workos-vault plugin used to inline. The parser must stay
// byte-for-byte equivalent to it, so we keep a private copy here purely to
// prove equivalence (the production parser references the SDK helper instead).
const LEGACY_REGEX = /^user-org:([^:]+):([^:]+)$/;

const legacyParse = (
  id: string,
): { readonly userId: string; readonly organizationId: string } | null => {
  const m = id.match(LEGACY_REGEX);
  return m ? { userId: m[1]!, organizationId: m[2]! } : null;
};

describe("userOrgScopeId / parseUserOrgScopeId", () => {
  it("produces the exact contract string", () => {
    expect(userOrgScopeId("u1", "org42")).toBe("user-org:u1:org42");
  });

  it.each([
    ["u1", "org42"],
    // Tricky-but-colon-free ids: uuids, dashes, dots, unicode, encoded chars.
    ["1a2b-c3d4", "00000000-0000-0000-0000-000000000000"],
    ["user.with.dots", "org_underscore"],
    ["usér", "örg"],
    ["a b c", "o r g"],
    ["user%3Aslash", "org+plus"],
  ])("round-trips parse(build(%j, %j))", (userId, organizationId) => {
    const parsed = parseUserOrgScopeId(userOrgScopeId(userId, organizationId));
    expect(parsed).toEqual({ userId, organizationId });
  });

  // The legacy regex requires non-empty segments, so a built id with an empty
  // segment does NOT round-trip. The empty-segment cases live in the
  // equivalence block below (`user-org::b`, `user-org:a:`).

  // Equivalence proof: for representative + adversarial inputs the new parser
  // must return exactly what the inlined workos-vault regex returned.
  it.each([
    "user-org:u1:org42",
    "user-org:a:b",
    "user-org::b", // empty user segment -> no match (greedy [^:]+ needs >=1)
    "user-org:a:", // empty org segment -> no match
    "user-org:a:b:c", // extra colon -> no match (anchored, exactly two segments)
    "user-org:a", // missing org segment -> no match
    "user-org:", // nothing -> no match
    "user-org:a:b ", // trailing space is part of the org segment -> matches
    " user-org:a:b", // leading space breaks the anchor -> no match
    "USER-ORG:a:b", // case-sensitive prefix -> no match
    "org42", // bare org id -> no match
    "user-org:a:b\nuser-org:c:d", // newline: $ would normally allow, but no `m` flag
    "prefix-user-org:a:b", // prefix not anchored -> no match
    "",
  ])("matches the legacy regex for %j", (id) => {
    expect(parseUserOrgScopeId(id)).toEqual(legacyParse(id));
  });
});

describe("makeUserOrgScopeStack", () => {
  it("builds [userOrgScope, orgScope] with byte-identical ids + naming", () => {
    const [userOrgScope, orgScope] = makeUserOrgScopeStack("u1", "org42", "Acme");

    expect(String(userOrgScope.id)).toBe("user-org:u1:org42");
    expect(userOrgScope.name).toBe("Personal · Acme");

    expect(String(orgScope.id)).toBe("org42");
    expect(orgScope.name).toBe("Acme");
  });

  it("orders innermost (user-org) first so per-user secrets isolate", () => {
    const stack = makeUserOrgScopeStack("u1", "org42", "Acme");
    expect(stack.map((s) => String(s.id))).toEqual(["user-org:u1:org42", "org42"]);
  });
});
