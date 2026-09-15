import { describe, expect, it } from "@effect/vitest";

import { formatHealthCheckArgs, parseHealthCheckArgs } from "./health-check-args";

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
