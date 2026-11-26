const REPO = "UsefulSoftwareCo/executor";

export const GITHUB_REPO_URL = `https://github.com/${REPO}`;

export function formatStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

const TTL_OK_MS = 30 * 60 * 1000;
const TTL_FAIL_MS = 60 * 1000;
const TIMEOUT_MS = 4000;

/* oxlint-disable executor/no-module-level-mutable-state -- the static site build shares one count across its pages */
let cached: { value: number | null; at: number } | null = null;
let inflight: Promise<number | null> | null = null;
/* oxlint-enable executor/no-module-level-mutable-state */

async function fetchStars(): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const init: RequestInit & { cf?: { cacheTtl: number; cacheEverything: boolean } } = {
      headers: { "User-Agent": "executor.sh", Accept: "application/vnd.github+json" },
      signal: controller.signal,
      cf: { cacheTtl: 1800, cacheEverything: true },
    };
    const res = await fetch(`https://api.github.com/repos/${REPO}`, init);
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function getStars(): Promise<number | null> {
  const now = Date.now();
  if (cached) {
    const ttl = cached.value != null ? TTL_OK_MS : TTL_FAIL_MS;
    if (now - cached.at < ttl) return Promise.resolve(cached.value);
  }
  if (inflight) return inflight;
  inflight = fetchStars().then((value) => {
    cached = { value, at: Date.now() };
    inflight = null;
    return value;
  });
  return inflight;
}
