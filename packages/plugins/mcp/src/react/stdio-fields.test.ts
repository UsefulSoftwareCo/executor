import { describe, expect, it } from "@effect/vitest";

import { formatStdioArgs, formatStdioEnv, parseStdioArgs, parseStdioEnv } from "./stdio-fields";

describe("parseStdioArgs", () => {
  it("splits on whitespace", () => {
    expect(parseStdioArgs("-y chrome-devtools-mcp@latest")).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
    ]);
  });

  it("keeps a double-quoted group intact", () => {
    expect(parseStdioArgs('--dir "/Users/a b/mcp" --port 3000')).toEqual([
      "--dir",
      "/Users/a b/mcp",
      "--port",
      "3000",
    ]);
  });

  it("returns nothing for a blank field", () => {
    expect(parseStdioArgs("   ")).toEqual([]);
  });
});

describe("formatStdioArgs", () => {
  it("re-quotes tokens containing whitespace so the round trip is lossless", () => {
    const args = ["--dir", "/Users/a b/mcp", "--port", "3000"];
    expect(parseStdioArgs(formatStdioArgs(args))).toEqual(args);
  });

  it("renders an absent list as an empty field", () => {
    expect(formatStdioArgs(undefined)).toBe("");
  });
});

describe("parseStdioEnv", () => {
  it("reads one KEY=value per line", () => {
    expect(parseStdioEnv("LOG_LEVEL=debug\nREGION=eu-west-1")).toEqual({
      LOG_LEVEL: "debug",
      REGION: "eu-west-1",
    });
  });

  it("splits on the first = only, so a value may contain =", () => {
    expect(parseStdioEnv("DSN=postgres://u:p@host/db?a=b")).toEqual({
      DSN: "postgres://u:p@host/db?a=b",
    });
  });

  it("keeps a declared-but-empty value", () => {
    expect(parseStdioEnv("NO_COLOR=")).toEqual({ NO_COLOR: "" });
  });

  it("drops blank lines, comments, and lines with no key", () => {
    expect(parseStdioEnv("\n# a comment\n=orphan\nA=1\n")).toEqual({ A: "1" });
  });
});

describe("formatStdioEnv", () => {
  it("round-trips a declared map", () => {
    const env = { LOG_LEVEL: "debug", DSN: "postgres://u:p@host/db?a=b" };
    expect(parseStdioEnv(formatStdioEnv(env))).toEqual(env);
  });

  it("renders an absent map as an empty field", () => {
    expect(formatStdioEnv(undefined)).toBe("");
  });
});
