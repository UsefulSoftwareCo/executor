import { describe, expect, it } from "@effect/vitest";

import { changelogEntryToHighlight, updateHighlights } from "./update-card";

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
