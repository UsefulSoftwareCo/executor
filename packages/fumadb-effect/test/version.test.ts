/**
 * `src/version.ts` replaces upstream fumadb's `semver` dependency. Every
 * expectation below is the documented semver 2.0.0 behaviour of `semver.parse`,
 * `semver.valid`, and `semver.compare`, which upstream used through
 * `validateSchema` (`valid`) and `fumadb()` (`compare`).
 */
import { describe, expect, it } from "vitest";
import { SchemaDefinitionError } from "../src/contracts/errors.ts";
import {
  compare,
  compareRaw,
  isValid,
  parse,
  parseOrThrow,
  sameVariant,
} from "../src/contracts/version.ts";

const version = (raw: string) => parseOrThrow(raw);

describe("parse", () => {
  it("reads the numeric components", () => {
    expect(parse("1.2.3")).toEqual({ raw: "1.2.3", major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it("reads a named variant as a single prerelease identifier", () => {
    expect(parse("1.0.0-with-admin")).toEqual({
      raw: "1.0.0-with-admin",
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ["with-admin"],
    });
  });

  it("keeps numeric prerelease identifiers as numbers", () => {
    expect(parse("1.0.0-alpha.1")?.prerelease).toEqual(["alpha", 1]);
    expect(parse("1.0.0-0.3.7")?.prerelease).toEqual([0, 3, 7]);
  });

  it("ignores build metadata, like semver precedence does", () => {
    const parsed = parse("1.0.0+20130313144700");
    expect(parsed?.prerelease).toEqual([]);
    expect(parsed?.raw).toBe("1.0.0+20130313144700");
    expect(parse("1.0.0-beta+exp.sha.5114f85")?.prerelease).toEqual(["beta"]);
  });

  it("accepts a leading `v`, like semver.valid", () => {
    expect(parse("v1.0.0")?.major).toBe(1);
  });

  it.each([
    ["", "empty"],
    ["1", "major only"],
    ["1.0", "no patch"],
    ["1.0.0.0", "four components"],
    ["01.0.0", "leading zero in major"],
    ["1.0.0-01", "leading zero in a numeric prerelease identifier"],
    ["1.0.0-", "empty prerelease"],
    ["latest", "not a version"],
    ["1.0.0-with admin", "space in the prerelease"],
  ])("rejects %j (%s)", (raw) => {
    expect(parse(raw)).toBeUndefined();
    expect(isValid(raw)).toBe(false);
  });

  it("parseOrThrow raises a SchemaDefinitionError for invalid input", () => {
    expect(() => parseOrThrow("nope")).toThrow(SchemaDefinitionError);
    expect(() => parseOrThrow("nope")).toThrow("the version nope is invalid.");
    expect(parseOrThrow("1.0.0").raw).toBe("1.0.0");
  });
});

describe("compare", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compare(version("1.0.0"), version("2.0.0"))).toBe(-1);
    expect(compare(version("2.0.0"), version("1.0.0"))).toBe(1);
    expect(compare(version("1.0.0"), version("1.1.0"))).toBe(-1);
    expect(compare(version("1.0.0"), version("1.0.1"))).toBe(-1);
    expect(compare(version("1.0.0"), version("1.0.0"))).toBe(0);
    // major wins over a larger minor
    expect(compare(version("1.9.9"), version("2.0.0"))).toBe(-1);
  });

  it("ignores build metadata", () => {
    expect(compare(version("1.0.0+a"), version("1.0.0+b"))).toBe(0);
  });

  it("orders a prerelease below its release", () => {
    expect(compare(version("1.0.0-alpha"), version("1.0.0"))).toBe(-1);
    expect(compare(version("1.0.0"), version("1.0.0-alpha"))).toBe(1);
  });

  it("follows the semver.org precedence example", () => {
    // 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta
    //   < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i] ?? "";
      const b = ordered[i + 1] ?? "";
      expect([a, b, compareRaw(a, b)]).toEqual([a, b, -1]);
      expect([b, a, compareRaw(b, a)]).toEqual([b, a, 1]);
    }
  });

  it("orders numeric identifiers below alphanumeric ones", () => {
    expect(compareRaw("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareRaw("1.0.0-2", "1.0.0-11")).toBe(-1);
    // string identifiers compare as ASCII text, so "11" as text would win
    expect(compareRaw("1.0.0-a2", "1.0.0-a11")).toBe(1);
  });

  it("orders a shorter prerelease below a longer one with the same prefix", () => {
    expect(compareRaw("1.0.0-alpha", "1.0.0-alpha.0")).toBe(-1);
  });

  it("sorts a schema list the way fumadb() does", () => {
    const raw = ["2.0.0", "1.0.0", "1.0.0-with-admin", "10.0.0", "1.2.0"];
    expect([...raw].sort(compareRaw)).toEqual([
      "1.0.0-with-admin",
      "1.0.0",
      "1.2.0",
      "2.0.0",
      "10.0.0",
    ]);
  });

  it("compareRaw rejects invalid input", () => {
    expect(() => compareRaw("1.0.0", "one")).toThrow(SchemaDefinitionError);
  });
});

describe("sameVariant", () => {
  it("groups releases together", () => {
    expect(sameVariant(version("1.0.0"), version("2.3.4"))).toBe(true);
  });

  it("groups a named variant with the same variant of another version", () => {
    expect(sameVariant(version("1.0.0-with-admin"), version("2.0.0-with-admin"))).toBe(true);
  });

  it("separates a variant from the base line", () => {
    expect(sameVariant(version("1.0.0"), version("1.0.0-with-admin"))).toBe(false);
    expect(sameVariant(version("1.0.0-with-admin"), version("1.0.0-with-billing"))).toBe(false);
  });

  it("compares every identifier", () => {
    expect(sameVariant(version("1.0.0-a.1"), version("2.0.0-a.1"))).toBe(true);
    expect(sameVariant(version("1.0.0-a.1"), version("2.0.0-a.2"))).toBe(false);
    expect(sameVariant(version("1.0.0-a"), version("2.0.0-a.1"))).toBe(false);
  });
});
