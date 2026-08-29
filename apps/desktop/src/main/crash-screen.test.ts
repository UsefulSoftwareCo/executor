/**
 * The screen is shown for an outside interrupt as well as a real crash — the
 * server is gone either way — so the one sentence that must not appear when
 * nothing was sent upstream is pinned here. Telling a user a report was filed
 * when none was is the visible half of the reported problem.
 */

import { describe, expect, it } from "@effect/vitest";
import { sidecarCrashHtml } from "./crash-screen";

const REPORT_CLAIM = "A crash report was sent automatically";

describe("sidecarCrashHtml", () => {
  it("claims nothing was sent when nothing was", () => {
    const html = sidecarCrashHtml({ reported: false });

    expect(html).not.toContain(REPORT_CLAIM);
    // The screen still has to explain the server is gone and offer a way back.
    expect(html).toContain("The local Executor server stopped unexpectedly");
    expect(html).toContain("Restart server");
  });

  it("says a report was sent when one was", () => {
    expect(sidecarCrashHtml({ reported: true })).toContain(REPORT_CLAIM);
  });
});
