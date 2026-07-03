/**
 * Safely coerce a value that may be a Date object, ISO string, or a timestamp
 * string without timezone info (e.g. from a raw SQL expression after JSON
 * serialization) into a UTC-based Date.
 */
function toDate(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);

  // Timestamp strings from the DB may lack a timezone indicator after JSON
  // round-tripping (e.g. "2024-01-15 10:00:00" or "2024-01-15T10:00:00").
  // Without 'Z' or an offset, browsers parse these as *local* time, which
  // silently shifts the value for users outside UTC and causes relative-time
  // labels to show "now" instead of "Xm ago" / "Xh ago".
  if (typeof value === "string") {
    const s = value.trim();
    const hasTimezone = s.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(s);
    if (!hasTimezone) {
      return new Date(s + "Z");
    }
  }

  return new Date(value);
}

/**
 * Format a date as a human-readable relative time string.
 * Accepts Date objects, ISO strings, and raw timestamp strings.
 *
 * @param suffix - Whether to append " ago" to relative labels (default: true)
 */
export function formatRelativeTime(
  date: Date | string,
  { suffix = true }: { suffix?: boolean } = {},
): string {
  const d = toDate(date);
  const ts = d.getTime();
  if (Number.isNaN(ts)) return "";

  const now = Date.now();
  const diffMs = now - ts;

  // Future dates (clock skew) → treat as just now
  if (diffMs < 0) return "now";

  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  const ago = suffix ? " ago" : "";

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m${ago}`;
  if (diffHours < 24) return `${diffHours}h${ago}`;
  if (diffDays < 7) return `${diffDays}d${ago}`;

  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
