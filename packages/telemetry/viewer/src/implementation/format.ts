export const formatDuration = (ms: number): string => {
  if (ms < 0.01) return "0ms";
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 10) return `${ms.toFixed(2)}ms`;
  if (ms < 100) return `${ms.toFixed(1)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
};

export const formatTimestamp = (date: Date | string): string => {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
};

export const formatRelativeTime = (date: Date | string): string => {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
};

// Deterministic color palette for service names
const SERVICE_COLORS = [
  "#f4a51c",
  "#6ec6ff",
  "#ff6b6b",
  "#51cf66",
  "#cc5de8",
  "#ffa94d",
  "#22b8cf",
  "#ff8787",
  "#69db7c",
  "#da77f2",
  "#ffd43b",
  "#3bc9db",
  "#ff9999",
  "#8ce99a",
  "#e599f7",
];

const colorCache = new Map<string, string>();

export const serviceColor = (name: string): string => {
  const cached = colorCache.get(name);
  if (cached) return cached;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  const color = SERVICE_COLORS[Math.abs(hash) % SERVICE_COLORS.length]!;
  colorCache.set(name, color);
  return color;
};

export const statusColor = (status: "ok" | "error"): string =>
  status === "error" ? "#ff6b6b" : "#51cf66";
