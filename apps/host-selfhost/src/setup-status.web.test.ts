import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { SetupStatusError, fetchNeedsSetup } from "../web/setup-status";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchNeedsSetup", () => {
  it("returns false when the server says setup is complete", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ needsSetup: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(fetchNeedsSetup()).resolves.toBe(false);
  });

  it("retries failed setup checks before surfacing an error", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    });

    await expect(fetchNeedsSetup()).rejects.toBeInstanceOf(SetupStatusError);
    expect(calls).toBe(3);
  });
});
