import { describe, expect, it } from "@effect/vitest";

import { formatRelativeTime } from "./relative-time";

const now = Date.UTC(2026, 6, 27, 12, 0, 0);
const ago = (ms: number): number => now - ms;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it("collapses anything under a minute to 'just now'", () => {
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(ago(59_000), now)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(formatRelativeTime(ago(MINUTE), now)).toBe("1m ago");
    expect(formatRelativeTime(ago(59 * MINUTE), now)).toBe("59m ago");
    expect(formatRelativeTime(ago(HOUR), now)).toBe("1h ago");
    expect(formatRelativeTime(ago(23 * HOUR), now)).toBe("23h ago");
    expect(formatRelativeTime(ago(DAY), now)).toBe("1d ago");
    expect(formatRelativeTime(ago(6 * DAY), now)).toBe("6d ago");
  });

  it("falls back to an absolute date once a week has passed", () => {
    // Beyond a week the relative figure stops being useful, so the exact date
    // is shown instead of an ever-growing day count.
    expect(formatRelativeTime(ago(7 * DAY), now)).not.toContain("ago");
  });

  it("never renders a future timestamp as negative", () => {
    // Clock skew between server and browser must not produce "-3m ago".
    expect(formatRelativeTime(now + HOUR, now)).toBe("just now");
  });
});
