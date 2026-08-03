/**
 * Compact relative timestamps for list metadata ("5m ago", "3d ago").
 *
 * The house format is compact rather than prose ("2h ago", not "2 hours ago"),
 * and falls back to an absolute date once the distance stops being useful as a
 * relative figure. `now` is injectable so callers can test without freezing the
 * clock.
 */
export const formatRelativeTime = (timestamp: number, now = Date.now()): string => {
  const diffMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
