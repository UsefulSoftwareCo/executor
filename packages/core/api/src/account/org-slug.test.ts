import { describe, expect, it } from "@effect/vitest";

import { RESERVED_ORG_SLUGS, generateOrgSlug, isValidOrgSlug, slugifyOrgName } from "./org-slug";

describe("slugifyOrgName", () => {
  it("derives clean slugs from real-world names", () => {
    expect(slugifyOrgName("Acme Corp")).toBe("acme-corp");
    expect(slugifyOrgName("Rhys's Organization")).toBe("rhys-s-organization");
    expect(slugifyOrgName("  Café Müller GmbH  ")).toBe("cafe-muller-gmbh");
    expect(slugifyOrgName("ACME (EU) — R&D")).toBe("acme-eu-r-d");
    expect(slugifyOrgName("a.b.c")).toBe("a-b-c");
  });

  it("returns null when nothing usable survives", () => {
    expect(slugifyOrgName("🚀🚀🚀")).toBeNull();
    expect(slugifyOrgName("--")).toBeNull();
    expect(slugifyOrgName("x")).toBeNull(); // below 2-char minimum
    expect(slugifyOrgName("")).toBeNull();
  });

  it("respects the 48-char budget", () => {
    const slug = slugifyOrgName(`${"very-".repeat(20)}long name`);
    expect(slug).not.toBeNull();
    expect(slug!.length).toBeLessThanOrEqual(48);
    expect(isValidOrgSlug(slug!)).toBe(true);
  });
});

describe("isValidOrgSlug", () => {
  it("accepts the grammar", () => {
    expect(isValidOrgSlug("acme")).toBe(true);
    expect(isValidOrgSlug("acme-corp-2")).toBe(true);
    expect(isValidOrgSlug("a1")).toBe(true);
  });

  it("rejects bad shapes", () => {
    expect(isValidOrgSlug("a")).toBe(false);
    expect(isValidOrgSlug("-acme")).toBe(false);
    expect(isValidOrgSlug("acme-")).toBe(false);
    expect(isValidOrgSlug("ac--me")).toBe(false);
    expect(isValidOrgSlug("Acme")).toBe(false);
    expect(isValidOrgSlug("acme_corp")).toBe(false);
    expect(isValidOrgSlug("org_01ABC")).toBe(false); // MCP org-id namespace
    expect(isValidOrgSlug("a".repeat(49))).toBe(false);
  });

  it("rejects every reserved slug", () => {
    for (const reserved of RESERVED_ORG_SLUGS) {
      expect(isValidOrgSlug(reserved), reserved).toBe(false);
    }
  });

  it("keeps self-host's turnkey default claimable", () => {
    // Existing self-host instances boot with slug "default"; reserving it
    // would invalidate them.
    expect(isValidOrgSlug("default")).toBe(true);
  });

  it("reserves the segments routing depends on", () => {
    for (const critical of ["api", "mcp", "integrations", "policies", "login", "cdn-cgi"]) {
      expect(RESERVED_ORG_SLUGS.has(critical), critical).toBe(true);
    }
  });
});

describe("generateOrgSlug", () => {
  const taken = (slugs: ReadonlyArray<string>) => async (slug: string) => slugs.includes(slug);
  // `acme-corp` + "-" + 4 chars of the look-alike-free alphabet.
  const discriminated = (base: string) => new RegExp(`^${base}-[a-z2-9]{4}$`);

  it("uses the clean derivation when free", async () => {
    expect(await generateOrgSlug("Acme Corp", taken([]))).toBe("acme-corp");
  });

  it("appends a random discriminator on collision, not an ordinal", async () => {
    const slug = await generateOrgSlug("Acme Corp", taken(["acme-corp"]));
    expect(slug).toMatch(discriminated("acme-corp"));
    expect(slug).not.toBe("acme-corp-2");
    expect(isValidOrgSlug(slug)).toBe(true);
  });

  it("retries the discriminator until free", async () => {
    // Reject every candidate once by remembering refusals — the generator
    // must come back with a DIFFERENT discriminator, not loop on one.
    const refused = new Set<string>(["acme-corp"]);
    let refusals = 0;
    const slug = await generateOrgSlug("Acme Corp", async (candidate) => {
      if (refused.has(candidate)) return true;
      if (refusals < 2) {
        refusals += 1;
        refused.add(candidate);
        return true;
      }
      return false;
    });
    expect(slug).toMatch(discriminated("acme-corp"));
    expect(refused.has(slug)).toBe(false);
  });

  it("discriminates reserved names instead of claiming them", async () => {
    expect(await generateOrgSlug("MCP", taken([]))).toMatch(discriminated("mcp"));
    expect(await generateOrgSlug("API", taken([]))).toMatch(discriminated("api"));
  });

  it("falls back to team handles for unusable names", async () => {
    // "team" itself is reserved, so the fallback is always discriminated.
    expect(await generateOrgSlug("🚀🚀🚀", taken([]))).toMatch(discriminated("team"));
  });

  it("keeps discriminated slugs within budget", async () => {
    const longName = `${"very-".repeat(20)}long name`;
    const base = await generateOrgSlug(longName, taken([]));
    const collided = await generateOrgSlug(longName, taken([base]));
    expect(collided.length).toBeLessThanOrEqual(48);
    expect(isValidOrgSlug(collided)).toBe(true);
  });
});
