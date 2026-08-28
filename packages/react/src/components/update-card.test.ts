import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import {
  changelogEntryToHighlight,
  fetchChangelogHighlights,
  updateHighlights,
} from "./update-card";

describe("update-card changelog highlights", () => {
  it("keeps the first three entries newer than the running version", () => {
    expect(
      updateHighlights(
        [
          {
            version: "1.5.31",
            entries: [
              { body: "**Desktop polish**\n- Keep title bars aligned." },
              { body: "Add [`docs`](https://executor.sh/docs) links to update cards." },
            ],
          },
          {
            version: "1.5.30",
            entries: [
              { body: "Fix `executor web` startup on Windows. More detail follows." },
              { body: "This fourth entry should not render." },
            ],
          },
          {
            version: "1.5.29",
            entries: [{ body: "Older release stays hidden." }],
          },
        ],
        "1.5.29",
      ),
    ).toEqual([
      "Desktop polish",
      "Add docs links to update cards.",
      "Fix executor web startup on Windows.",
    ]);
  });

  it("returns no highlights when the running version is unknown", () => {
    expect(
      updateHighlights([{ version: "1.5.31", entries: [{ body: "New entry." }] }], undefined),
    ).toEqual([]);
  });

  it("turns markdown bodies into compact one-line text", () => {
    expect(
      changelogEntryToHighlight(
        "**OAuth fixes** for [`login`](https://executor.sh/docs).\n- Nested detail is ignored.",
      ),
    ).toBe("OAuth fixes for login.");
  });
});

describe("fetchChangelogHighlights", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (impl: typeof fetch) => vi.stubGlobal("fetch", vi.fn(impl));

  /** A connection that never answers, the way a blackholed request behaves. */
  const hangUntilAborted =
    (onAbort?: () => void): typeof fetch =>
    async (_input, init) => {
      await new Promise<void>((resolve) => {
        init?.signal?.addEventListener("abort", () => resolve());
      });
      onAbort?.();
      throw init?.signal?.reason ?? new Error("aborted");
    };

  it("reads highlights from a well-formed payload", async () => {
    stubFetch(() =>
      Promise.resolve(
        Response.json({
          releases: [{ version: "1.5.31", entries: [{ body: "A newer thing." }] }],
        }),
      ),
    );

    expect(await fetchChangelogHighlights("1.5.30")).toEqual(["A newer thing."]);
  });

  it("falls back to no highlights when the request fails", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    expect(await fetchChangelogHighlights("1.5.30")).toEqual([]);
  });

  it("falls back to no highlights on a non-200 or malformed payload", async () => {
    stubFetch(() => Promise.resolve(new Response("nope", { status: 503 })));
    expect(await fetchChangelogHighlights("1.5.30")).toEqual([]);

    stubFetch(() => Promise.resolve(Response.json({ releases: "not an array" })));
    expect(await fetchChangelogHighlights("1.5.30")).toEqual([]);
  });

  // An air-gapped self-hosted install cannot reach executor.sh, and a blackholed
  // connection never rejects on its own: the timeout is what ends the request.
  it("gives up on a request that never settles", async () => {
    let aborted = false;
    stubFetch(hangUntilAborted(() => (aborted = true)));

    expect(await fetchChangelogHighlights("1.5.30", { timeoutMs: 10 })).toEqual([]);
    expect(aborted, "the hanging request is aborted, not left open").toBe(true);
  });

  it("gives up when the caller's signal aborts first", async () => {
    const controller = new AbortController();
    stubFetch(hangUntilAborted());

    const pending = fetchChangelogHighlights("1.5.30", { signal: controller.signal });
    controller.abort();

    expect(await pending).toEqual([]);
  });
});
