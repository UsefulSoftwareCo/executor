export type DesktopDownloadOs = "mac-arm64" | "mac-x64" | "win-x64" | "linux-x64" | "linux-arm64";

export interface DesktopDownloadTarget {
  readonly os: DesktopDownloadOs;
  readonly asset: string;
  readonly label: string;
}

export interface DesktopReleaseSource {
  readonly releasesApi: string;
  readonly tagPrefix: string;
  readonly stableOnly: boolean;
}

type ReleaseAsset = { readonly name: string; readonly url: string };
export type PublishedRelease = {
  readonly tag: string;
  readonly prerelease: boolean;
  readonly publishedAt: string;
  readonly assets: ReadonlyArray<ReleaseAsset>;
};

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
  source: Pick<DesktopReleaseSource, "tagPrefix" | "stableOnly">,
): PublishedRelease | null =>
  releases
    .filter(
      (release) =>
        release.tag.startsWith(source.tagPrefix) && !(source.stableOnly && release.prerelease),
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

const cacheKey = (source: DesktopReleaseSource) =>
  `executor-desktop-release:${source.releasesApi}:${source.tagPrefix}:${source.stableOnly}`;

export const fetchNewestRelease = async (
  source: DesktopReleaseSource,
): Promise<PublishedRelease | null> => {
  const key = cacheKey(source);
  const cached = sessionStorage.getItem(key);
  if (cached !== null) return readCachedRelease(JSON.parse(cached));
  const response = await fetch(source.releasesApi, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) return null;
  const release = newestRelease(readReleases(await response.json()), source);
  if (release !== null) sessionStorage.setItem(key, JSON.stringify(release));
  return release;
};

type UserAgentData = {
  readonly platform: string;
  readonly mobile?: boolean;
  readonly getHighEntropyValues?: (
    hints: ReadonlyArray<string>,
  ) => Promise<{ readonly architecture?: string }>;
};

const userAgentData = () =>
  (navigator as Navigator & { readonly userAgentData?: UserAgentData }).userAgentData;

export const handheldDevice = () => {
  const ua = navigator.userAgent;
  if (userAgentData()?.mobile === true) return true;
  if (/\b(?:iPhone|iPad|iPod|Android)\b/u.test(ua)) return true;
  return /\bMacintosh\b/u.test(ua) && navigator.maxTouchPoints > 1;
};

const architecture = async (data: UserAgentData | undefined) => {
  if (data?.getHighEntropyValues === undefined) return undefined;
  try {
    return (await data.getHighEntropyValues(["architecture"])).architecture;
  } catch {
    return undefined;
  }
};

export const detectDesktopOs = async (): Promise<DesktopDownloadOs | null> => {
  if (handheldDevice()) return null;
  const data = userAgentData();
  const platform = (data?.platform ?? navigator.platform ?? "").toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (platform.includes("win") || ua.includes("windows")) return "win-x64";
  if (platform.includes("linux") || ua.includes("linux")) {
    if ((await architecture(data)) === "arm") return "linux-arm64";
    return ua.includes("aarch64") ? "linux-arm64" : "linux-x64";
  }
  if (platform.includes("mac") || ua.includes("mac")) {
    if ((await architecture(data)) === "x86") return "mac-x64";
    return "mac-arm64";
  }
  return null;
};

export const desktopReleaseRepository = "UsefulSoftwareCo/executor";

export const desktopReleaseSource = (major: string): DesktopReleaseSource => ({
  releasesApi: `https://api.github.com/repos/${desktopReleaseRepository}/releases?per_page=100`,
  tagPrefix: `executor@${major}.`,
  stableOnly: false,
});

export const desktopDownloadTargets: ReadonlyArray<DesktopDownloadTarget> = [
  { os: "mac-arm64", asset: "-mac-arm64.dmg", label: "Download for Mac" },
  { os: "mac-x64", asset: "-mac-x64.dmg", label: "Download for Mac (Intel)" },
  { os: "linux-x64", asset: "-linux-x86_64.AppImage", label: "Download for Linux (x64)" },
  { os: "linux-arm64", asset: "-linux-arm64.AppImage", label: "Download for Linux (ARM64)" },
  { os: "win-x64", asset: "-win-x64.exe", label: "Download for Windows" },
];
