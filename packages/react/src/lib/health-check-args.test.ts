import { describe, expect, it } from "@effect/vitest";

import {
  formatHealthCheckArgs,
  formatJsonArguments,
  parseHealthCheckArgs,
  parseJsonArguments,
} from "./health-check-args";

describe("health-check request bodies", () => {
  it("preserves nested values through editing and saving", () => {
    const args = {
      "Connect-Protocol-Version": "1",
      body: {
        pageSize: 1,
        status: ["queued", "running", "finished", "failed", "cancelled"],
        filter: { enabled: false },
      },
    };
    expect(parseHealthCheckArgs(formatHealthCheckArgs(args))).toEqual({ ok: true, args });
    for (const body of [null, false, 0, "plain text", [1, 2]]) {
      expect(parseHealthCheckArgs(formatHealthCheckArgs({ body }))).toEqual({
        ok: true,
        args: { body },
      });
    }
  });

  it("rejects invalid JSON and drops a cleared optional body", () => {
    expect(parseHealthCheckArgs({ body: '{"pageSize":' })).toEqual({ ok: false });
    expect(parseHealthCheckArgs({ body: "   ", id: " me " })).toEqual({
      ok: true,
      args: { id: "me" },
    });
  });
});

describe("health-check tool arguments", () => {
  it("round trips a typed arguments object, including a literal body argument", () => {
    const args = {
      limit: 1,
      enabled: false,
      values: [1, "two"],
      options: { nested: true },
      nullable: null,
      body: "literal body",
      label: " spaced ",
    };
    expect(parseJsonArguments(formatJsonArguments(args))).toEqual({ ok: true, args });
  });

  it("keeps arguments whose names collide with Object.prototype members", () => {
    const text = '{"__proto__":{"x":1},"constructor":"c","toString":2}';
    const parsed = parseJsonArguments(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.hasOwn(parsed.args, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed.args)).toBe(Object.prototype);
    expect(JSON.stringify(parsed.args)).toBe(text);
    // Reopening the saved arguments in the editor keeps them intact.
    const reopened = parseJsonArguments(formatJsonArguments(parsed.args));
    expect(reopened.ok && JSON.stringify(reopened.args)).toBe(text);
  });

  it("reads blank as no arguments and accepts only a JSON object", () => {
    expect(parseJsonArguments("  ")).toEqual({ ok: true, args: {} });
    expect(formatJsonArguments({})).toBe("");
    expect(formatJsonArguments(undefined)).toBe("");
    for (const text of ["{", "[1]", "null", "1", '"text"', "true", "text"]) {
      expect(parseJsonArguments(text)).toEqual({ ok: false });
    }
  });
});
