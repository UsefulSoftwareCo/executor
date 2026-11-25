type ReleaseAsset = { readonly name: string; readonly url: string };
type PublishedRelease = {
  readonly tag: string;
  readonly prerelease: boolean;
  readonly publishedAt: string;
  readonly assets: ReadonlyArray<ReleaseAsset>;
};

export type ReleaseFilter = { readonly tagPrefix: string; readonly stableOnly: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readAsset = (value: unknown): ReleaseAsset | null =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.browser_download_url === "string"
    ? { name: value.name, url: value.browser_download_url }
    : null;

const readRelease = (value: unknown): PublishedRelease | null =>
  isRecord(value) &&
  value.draft !== true &&
  typeof value.tag_name === "string" &&
  typeof value.prerelease === "boolean" &&
  typeof value.published_at === "string" &&
  Array.isArray(value.assets)
    ? {
        tag: value.tag_name,
        prerelease: value.prerelease,
        publishedAt: value.published_at,
        assets: value.assets.flatMap((asset: unknown) => readAsset(asset) ?? []),
      }
    : null;

export const readReleases = (body: unknown): ReadonlyArray<PublishedRelease> =>
  Array.isArray(body) ? body.flatMap((value: unknown) => readRelease(value) ?? []) : [];

export const newestRelease = (
  releases: ReadonlyArray<PublishedRelease>,
  filter: ReleaseFilter,
): PublishedRelease | null =>
  releases
    .filter(
      (release) =>
        release.tag.startsWith(filter.tagPrefix) && !(filter.stableOnly && release.prerelease),
    )
    .reduce<PublishedRelease | null>(
      (newest, release) =>
        newest === null || Date.parse(release.publishedAt) > Date.parse(newest.publishedAt)
          ? release
          : newest,
      null,
    );

export const assetUrl = (release: PublishedRelease, suffix: string): string | null =>
  release.assets.find((asset) => asset.name.endsWith(suffix))?.url ?? null;

const readCachedRelease = (value: unknown): PublishedRelease | null =>
  isRecord(value) &&
  typeof value.tag === "string" &&
  typeof value.prerelease === "boolean" &&
  typeof value.publishedAt === "string" &&
  Array.isArray(value.assets)
    ? {
        tag: value.tag,
        prerelease: value.prerelease,
        publishedAt: value.publishedAt,
        assets: value.assets.flatMap((asset: unknown) =>
          isRecord(asset) && typeof asset.name === "string" && typeof asset.url === "string"
            ? [{ name: asset.name, url: asset.url }]
            : [],
        ),
      }
    : null;

const cacheKey = (api: string, filter: ReleaseFilter) =>
  `executor-desktop-release:${api}:${filter.tagPrefix}:${filter.stableOnly}`;

export const fetchNewestRelease = async (
  api: string,
  filter: ReleaseFilter,
): Promise<PublishedRelease | null> => {
  const key = cacheKey(api, filter);
  const cached = sessionStorage.getItem(key);
  if (cached !== null) return readCachedRelease(JSON.parse(cached));
  const response = await fetch(api, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) return null;
  const release = newestRelease(readReleases(await response.json()), filter);
  if (release !== null) sessionStorage.setItem(key, JSON.stringify(release));
  return release;
};
