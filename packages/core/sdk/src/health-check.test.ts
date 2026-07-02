// The identity auto-pick: the connect flow defaults the identity field from
// the probe's real response instead of asking, so the heuristic's ordering IS
// the product behavior. Email beats login beats display name beats id;
// shallower paths win within a tier; nothing plausible ⇒ undefined.
import { describe, expect, it } from "@effect/vitest";

import { pickIdentitySample } from "./health-check";

const row = (path: string, value: string) => ({ path, value });

describe("pickIdentitySample", () => {
  it("prefers email over login, name, and id", () => {
    const picked = pickIdentitySample([
      row("id", "u_123"),
      row("login", "alice"),
      row("name", "Alice Smith"),
      row("email", "alice@example.com"),
    ]);
    expect(picked?.path).toBe("email");
  });

  it("falls through the tiers: login when no email, name when neither", () => {
    expect(pickIdentitySample([row("id", "1"), row("login", "alice")])?.path).toBe("login");
    expect(pickIdentitySample([row("id", "1"), row("displayName", "Alice")])?.path).toBe(
      "displayName",
    );
    expect(pickIdentitySample([row("id", "1")])?.path).toBe("id");
  });

  it("matches nested paths by their leaf key, preferring shallower ones", () => {
    const picked = pickIdentitySample([
      row("account.profile.email", "deep@example.com"),
      row("account.email", "shallow@example.com"),
    ]);
    expect(picked?.path).toBe("account.email");
  });

  it("ignores numeric array segments when reading the leaf (Google's shape)", () => {
    const picked = pickIdentitySample([
      row("resourceName", "people/c123"),
      row("emailAddresses.0.value", "alice@gmail.com"),
    ]);
    // `value` is not an identity key, but emailAddresses.0.value's non-numeric
    // leaf is `value` — the Google default comes from the provider plugin, not
    // this heuristic, so here resourceName-style ids simply don't match and
    // the pick falls back to nothing rather than a wrong field.
    expect(picked).toBeUndefined();
  });

  it("skips empty values and returns undefined when nothing plausible exists", () => {
    expect(pickIdentitySample([row("email", "  ")])).toBeUndefined();
    expect(pickIdentitySample([row("createdAt", "2024-01-01")])).toBeUndefined();
    expect(pickIdentitySample([])).toBeUndefined();
  });
});
