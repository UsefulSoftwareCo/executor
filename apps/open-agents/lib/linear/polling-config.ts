const DEFAULT_LINEAR_POLL_LOOKBACK_MS = 5 * 60 * 1000;
const DEFAULT_LINEAR_POLL_OVERLAP_MS = 2 * 60 * 1000;
const DEFAULT_LINEAR_POLL_PAGE_SIZE = 100;
const DEFAULT_LINEAR_POLL_MAX_PAGES = 5;

function readBooleanEnv(name: string): boolean | null {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return null;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  return null;
}

function readPositiveIntegerEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hasListValue(name: string): boolean {
  return (process.env[name] ?? "")
    .split(",")
    .some((value) => value.trim().length > 0);
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

export function getLinearPollingToken(): string | null {
  return firstNonEmpty(
    process.env.LINEAR_API_KEY,
    process.env.LINEAR_ACCESS_TOKEN,
  );
}

export function areLinearWebhooksEnabled(): boolean {
  const explicit = readBooleanEnv("OPEN_AGENTS_LINEAR_WEBHOOKS_ENABLED");
  if (explicit !== null) {
    return explicit;
  }

  return Boolean(process.env.LINEAR_WEBHOOK_SECRET?.trim());
}

export function isLinearPollingSourceEnabled(): boolean {
  const explicit = readBooleanEnv("OPEN_AGENTS_LINEAR_POLLING_ENABLED");
  if (explicit === false) {
    return false;
  }

  const pollingRequested = explicit === true || !areLinearWebhooksEnabled();
  return (
    pollingRequested &&
    getLinearPollingToken() !== null &&
    (hasListValue("OPEN_AGENTS_LINEAR_PROJECTS") ||
      hasListValue("OPEN_AGENTS_LINEAR_TEAMS"))
  );
}

export function getLinearPollLookbackMs(): number {
  return (
    readPositiveIntegerEnv("OPEN_AGENTS_LINEAR_POLL_LOOKBACK_MS") ??
    DEFAULT_LINEAR_POLL_LOOKBACK_MS
  );
}

export function getLinearPollOverlapMs(): number {
  return (
    readPositiveIntegerEnv("OPEN_AGENTS_LINEAR_POLL_OVERLAP_MS") ??
    DEFAULT_LINEAR_POLL_OVERLAP_MS
  );
}

export function getLinearPollPageSize(): number {
  return (
    readPositiveIntegerEnv("OPEN_AGENTS_LINEAR_POLL_PAGE_SIZE") ??
    DEFAULT_LINEAR_POLL_PAGE_SIZE
  );
}

export function getLinearPollMaxPages(): number {
  return (
    readPositiveIntegerEnv("OPEN_AGENTS_LINEAR_POLL_MAX_PAGES") ??
    DEFAULT_LINEAR_POLL_MAX_PAGES
  );
}
