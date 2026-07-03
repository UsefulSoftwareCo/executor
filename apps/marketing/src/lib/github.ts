// GitHub repo metadata for the nav's "Star on GitHub" pill.
//
// The marketing site is SSR (astro.config `output: "server"`) on Cloudflare
// Workers, so this runs per request rather than at build time. To keep that
// cheap and resilient we:
//   - memoize the count in module scope with a TTL, so a warm isolate hits the
//     GitHub API at most once per window and dedupes concurrent requests;
//   - hint Cloudflare to edge-cache the upstream response (ignored by Node in
//     `astro dev`);
//   - time out fast so a slow upstream never holds up the homepage; and
//   - resolve to null on any failure, in which case the nav simply drops the
//     count and keeps the link.

const REPO = "UsefulSoftwareCo/executor";

export const GITHUB_REPO_URL = `https://github.com/${REPO}`;

/** Compact star count, e.g. 1234 -> "1.2k". */
export function formatStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

const TTL_OK_MS = 30 * 60 * 1000; // cache a real count for ~30 min per isolate
const TTL_FAIL_MS = 60 * 1000; // but retry soon after a miss, never pin a null
const TIMEOUT_MS = 4000;

let cached: { value: number | null; at: number } | null = null;
let inflight: Promise<number | null> | null = null;

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

/** Live star count, memoized per isolate with a TTL. null when unavailable. */
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
