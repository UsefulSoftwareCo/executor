// ---------------------------------------------------------------------------
// Update check: one source of truth for "is a newer Executor published?"
//
// Both surfaces that tell a user to upgrade read from here:
//   - the CLI prints an "update available" line under its ready banner, and
//   - the web/desktop shell lights up its sidebar UpdateCard,
// the latter by fetching the `/v1/app/npm/dist-tags` route (see
// `server/npm-dist-tags.ts`), which serves `resolveDistTags()` verbatim.
//
// The semver helpers are a deliberate port of the ones the web shell already
// carries (`packages/app/src/web/shell.tsx`) so the client- and server-side
// "is this newer?" verdicts can never disagree.
//
// Resolution order (see `resolveDistTags`):
//   1. `EXECUTOR_DISABLE_UPDATE_CHECK` set  -> {} (no check, both surfaces quiet)
//   2. `EXECUTOR_NPM_DIST_TAGS` JSON override -> parsed tags (tests / air-gapped)
//   3. `EXECUTOR_FORCE_LATEST_VERSION` single value -> { latest, beta } = value
//   4. npm registry dist-tags endpoint, cached in-process
//   5. any failure -> {} (the check is best-effort; never a hard error)
// ---------------------------------------------------------------------------

export type UpdateChannel = "latest" | "beta";

/** The published npm package the CLI ships as. */
export const EXECUTOR_PACKAGE_NAME = "executor";

/** Lightweight dist-tags-only registry endpoint (not the full packument). */
const NPM_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${EXECUTOR_PACKAGE_NAME}/dist-tags`;

/** How long a successful registry lookup is reused before refetching. */
const DIST_TAGS_TTL_MS = 10 * 60 * 1000;

/** How long an empty result (offline, timeout, no tags) is reused before
 *  retrying. Negative-caches failures so an air-gapped server does not pay the
 *  fetch timeout on every shell load, while still recovering quickly. */
const EMPTY_TTL_MS = 60 * 1000;

/** How long to wait on the registry before giving up (a check, not a gate). */
const NPM_FETCH_TIMEOUT_MS = 1500;

// ── Semver (ported from the web shell, kept byte-for-byte in behaviour) ────

type ParsedVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number> | null;
};

const semverPattern =
  /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const resolveUpdateChannel = (version: string): UpdateChannel =>
  version.includes("-beta.") ? "beta" : "latest";

const parseVersion = (version: string): ParsedVersion | null => {
  const match = version.trim().match(semverPattern);
  if (!match?.groups) return null;
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease
      ? match.groups.prerelease.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id))
      : null,
  };
};

const comparePrereleaseIdentifiers = (
  left: ReadonlyArray<string | number> | null,
  right: ReadonlyArray<string | number> | null,
): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") return l < r ? -1 : 1;
    if (typeof l === "number") return -1;
    if (typeof r === "number") return 1;
    return l < r ? -1 : 1;
  }
  return 0;
};

/**
 * `-1` if `left` is older than `right`, `1` if newer, `0` if equal, `null` if
 * either side is not parseable semver.
 */
export const compareVersions = (left: string, right: string): number | null => {
  const lv = parseVersion(left);
  const rv = parseVersion(right);
  if (!lv || !rv) return null;
  if (lv.major !== rv.major) return lv.major < rv.major ? -1 : 1;
  if (lv.minor !== rv.minor) return lv.minor < rv.minor ? -1 : 1;
  if (lv.patch !== rv.patch) return lv.patch < rv.patch ? -1 : 1;
  return comparePrereleaseIdentifiers(lv.prerelease, rv.prerelease);
};

// ── dist-tags resolution ──────────────────────────────────────────────────

export type DistTags = Partial<Record<UpdateChannel, string>>;

export type ResolveDistTagsOptions = {
  /** Env source; defaults to `process.env`. Injectable for tests. */
  readonly env?: Record<string, string | undefined>;
  /** Fetch impl; defaults to global `fetch`. Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
};

type CacheEntry = { readonly at: number; readonly tags: DistTags };
let registryCache: CacheEntry | null = null;

// Read `process.env` without a hard `process` reference, so this module stays
// isomorphic (it is pulled into the browser-side type graph via the shared web
// shell's update card, which has no node types).
const ambientEnv = (): Record<string, string | undefined> => {
  const globalProcess = (
    globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } }
  ).process;
  return globalProcess?.env ?? {};
};

/** Reset the in-process registry cache. Test seam. */
export const __resetDistTagsCache = (): void => {
  registryCache = null;
};

const pickTags = (value: unknown): DistTags => {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const tags: DistTags = {};
  if (typeof record.latest === "string") tags.latest = record.latest;
  if (typeof record.beta === "string") tags.beta = record.beta;
  return tags;
};

const parseTagsJson = (raw: string): DistTags | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: an operator-supplied env override is untrusted text; a malformed value is ignored, not fatal
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: untrusted env override, structurally validated by pickTags below
    return pickTags(JSON.parse(raw));
  } catch {
    return null;
  }
};

const overrideFromEnv = (env: Record<string, string | undefined>): DistTags | null => {
  const raw = env.EXECUTOR_NPM_DIST_TAGS?.trim();
  if (raw) {
    const parsed = parseTagsJson(raw);
    if (parsed) return parsed;
  }
  const forced = env.EXECUTOR_FORCE_LATEST_VERSION?.trim();
  if (forced) return { latest: forced, beta: forced };
  return null;
};

/**
 * Resolve the published dist-tags for the `executor` package. Best-effort:
 * returns `{}` when disabled, offline, timed out, or the registry misbehaves,
 * never throws.
 */
export const resolveDistTags = async (options?: ResolveDistTagsOptions): Promise<DistTags> => {
  const env = options?.env ?? ambientEnv();
  if (env.EXECUTOR_DISABLE_UPDATE_CHECK) return {};

  const override = overrideFromEnv(env);
  if (override) return override;

  const now = Date.now();
  if (registryCache) {
    // Empty results (failures, or a package with no tags) carry the shorter
    // negative TTL so a transient outage recovers quickly; real tags stick.
    const ttl =
      registryCache.tags.latest || registryCache.tags.beta ? DIST_TAGS_TTL_MS : EMPTY_TTL_MS;
    if (now - registryCache.at < ttl) return registryCache.tags;
  }

  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: best-effort fetch of an external registry; any failure (offline, timeout, bad JSON) collapses to "no update signal", never an error
  try {
    const res = await fetchImpl(NPM_DIST_TAGS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(NPM_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      registryCache = { at: now, tags: {} };
      return {};
    }
    const tags = pickTags(await res.json());
    registryCache = { at: now, tags };
    return tags;
  } catch {
    registryCache = { at: now, tags: {} };
    return {};
  }
};

// ── checkForUpdate ─────────────────────────────────────────────────────────

export type UpdateStatus = {
  readonly updateAvailable: boolean;
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly channel: UpdateChannel;
  /** Suggested upgrade command, e.g. `npm i -g executor@latest`. */
  readonly command: string;
};

/**
 * Compare a running version against the published dist-tags for its channel.
 * Best-effort: an unreachable registry yields `updateAvailable: false`.
 */
export const checkForUpdate = async (
  currentVersion: string,
  options?: ResolveDistTagsOptions,
): Promise<UpdateStatus> => {
  const channel = resolveUpdateChannel(currentVersion);
  const command = `npm i -g ${EXECUTOR_PACKAGE_NAME}@${channel}`;
  const tags = await resolveDistTags(options);
  const latestVersion = tags[channel] ?? null;
  const updateAvailable =
    latestVersion !== null && compareVersions(currentVersion, latestVersion) === -1;
  return { updateAvailable, currentVersion, latestVersion, channel, command };
};
