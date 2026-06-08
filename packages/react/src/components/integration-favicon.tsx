import { BoxIcon } from "lucide-react";
import { useState } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import { getDomain } from "tldts";

// ---------------------------------------------------------------------------
// IntegrationFavicon — renders a small favicon derived from an integration URL.
// Falls back to a neutral icon if the URL is missing or the image fails to load.
// ---------------------------------------------------------------------------

export function integrationFaviconUrl(url: string | undefined, size: number): string | null {
  if (!url) return null;
  const domain = getDomain(url) ?? (URL.canParse(url) ? getDomain(new URL(url).hostname) : null);
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size * 2}`;
}

export function integrationLocalIconUrl(sourceId: string | undefined): string | null {
  if (sourceId !== "executor") return null;
  return "/favicon-32.png";
}

const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  googleDiscovery: "openapi",
};

const normalizeUrl = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/\/$/, "");
  }
};

const normalizeToken = (value: string | undefined): string =>
  value?.toLowerCase().replace(/[^a-z0-9]+/g, "") ?? "";

export function integrationInferredUrl(source: {
  readonly id: string;
  readonly name?: string;
}): string | null {
  const hostPattern = /^[a-z0-9][a-z0-9.-]*\.(?:app|co|com|dev|io|net|org)(?:\/.*)?$/i;
  const hostLike = [source.name, source.id.replaceAll("_", ".")]
    .filter((value): value is string => value != null && value.length > 0)
    .find((value) => hostPattern.test(value.trim()));
  if (hostLike) return `https://${hostLike.trim().replace(/^https?:\/\//i, "")}`;

  return null;
}

const tokenMatches = (sourceValue: string, presetValue: string): boolean =>
  presetValue.length > 0 &&
  sourceValue.length > 0 &&
  (sourceValue === presetValue ||
    sourceValue.includes(presetValue) ||
    presetValue.includes(sourceValue));

export function integrationPresetIconUrl(
  source: {
    readonly id: string;
    readonly kind: string;
    readonly name?: string;
    readonly url?: string;
  },
  integrationPlugins: readonly IntegrationPlugin[],
): string | null {
  const pluginKey = KIND_TO_PLUGIN_KEY[source.kind] ?? source.kind;
  const plugin = integrationPlugins.find((p) => p.key === pluginKey);
  const presets = plugin?.presets ?? [];
  const sourceUrl = normalizeUrl(source.url);
  const sourceId = normalizeToken(source.id);
  const sourceName = normalizeToken(source.name);

  const preset = presets.find((p) => {
    const presetUrl = normalizeUrl(p.url);
    const presetId = normalizeToken(p.id);
    const presetName = normalizeToken(p.name);
    return (
      (sourceUrl !== null && presetUrl === sourceUrl) ||
      tokenMatches(sourceId, presetId) ||
      tokenMatches(sourceName, presetName)
    );
  });

  return preset?.icon ?? null;
}

export function IntegrationFavicon({
  icon,
  sourceId,
  url,
  size = 16,
}: {
  icon?: string | null;
  sourceId?: string;
  url?: string;
  size?: number;
}) {
  const [failedSrcs, setFailedSrcs] = useState<readonly string[]>([]);
  const src =
    [icon ?? null, integrationLocalIconUrl(sourceId), integrationFaviconUrl(url, size)].find(
      (candidate) => candidate !== null && !failedSrcs.includes(candidate),
    ) ?? null;

  if (!src) {
    return (
      <BoxIcon
        aria-hidden
        className="shrink-0 text-muted-foreground"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() =>
        setFailedSrcs((current) => (current.includes(src) ? current : [...current, src]))
      }
      className="shrink-0 rounded-sm"
      style={{ width: size, height: size }}
    />
  );
}
