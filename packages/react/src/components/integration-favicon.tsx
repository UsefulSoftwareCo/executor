import { BoxIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { IntegrationPlugin } from "@executor-js/sdk/client";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { getDomain } from "tldts";

import {
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "../api/server-connection";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------

const EXECUTOR_ICON_SCHEME = "executor:";

const IconResponse = Schema.Struct({ icon: Schema.NullOr(Schema.String) });
const decodeIconResponse = Schema.decodeUnknownOption(IconResponse);

const resolvedExecutorIcons = new Map<string, Promise<string | null>>();

/** Resolves an authenticated local icon path once per browser session. */
const resolveExecutorIcon = (path: string): Promise<string | null> => {
  const cached = resolvedExecutorIcons.get(path);
  if (cached) return cached;
  const authorization = getExecutorServerAuthorizationHeader();
  const request = Effect.runPromise(
    Effect.tryPromise(async () => {
      const response = await fetch(`${getExecutorApiBaseUrl()}${path}`, {
        headers: authorization === null ? {} : { authorization },
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return Option.match(decodeIconResponse(body), {
        onNone: () => null,
        onSome: ({ icon }) => icon,
      });
    }).pipe(Effect.orElseSucceed(() => null)),
  );
  resolvedExecutorIcons.set(path, request);
  return request;
};

// ---------------------------------------------------------------------------
// IntegrationFavicon — renders a small favicon derived from an integration URL.
// Falls back to a neutral icon if the URL is missing or the image fails to load.
// ---------------------------------------------------------------------------

const integrationFaviconDomain = (url: string | undefined): string | null => {
  if (!url) return null;
  return getDomain(url) ?? (URL.canParse(url) ? getDomain(new URL(url).hostname) : null);
};

// integrations.sh/logo proxies context.dev's Logo Link behind an edge cache
// and is executor's single logo source. Fallbacks (Google's favicon service,
// a letter placeholder for unknown domains) live inside the proxy, so clients
// never resolve favicons against a third party directly.
export function integrationFaviconUrl(url: string | undefined, size: number): string | null {
  const domain = integrationFaviconDomain(url);
  if (!domain) return null;
  return `https://integrations.sh/logo/${domain}?sz=${size * 2}`;
}

export function integrationLocalIconUrl(integrationId: string | undefined): string | null {
  if (integrationId !== "executor") return null;
  return "/favicon-32.png";
}

const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  googleDiscovery: "google",
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

const googleApiServiceFromUrl = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (
      hostname === "www.googleapis.com" &&
      segments[0] === "discovery" &&
      segments[2] === "apis" &&
      segments[3]
    ) {
      return segments[3];
    }

    if (hostname === "www.googleapis.com") return segments[0] ?? null;

    const suffix = ".googleapis.com";
    if (hostname.endsWith(suffix)) {
      const service = hostname.slice(0, -suffix.length);
      return service.length > 0 ? service : null;
    }
  } catch {
    return null;
  }
  return null;
};

export function integrationInferredUrl(integration: {
  readonly id: string;
  readonly name?: string;
}): string | null {
  const hostPattern = /^[a-z0-9][a-z0-9.-]*\.(?:app|co|com|dev|io|net|org)(?:\/.*)?$/i;
  const hostLike = [integration.name, integration.id.replaceAll("_", ".")]
    .filter((value): value is string => value != null && value.length > 0)
    .find((value) => hostPattern.test(value.trim()));
  if (hostLike) return `https://${hostLike.trim().replace(/^https?:\/\//i, "")}`;

  return null;
}

// Exact identity signals only — preset defaultSlug, normalized URL equality,
// or the same Google discovery service. Fuzzy name/slug token matching used to
// live here and matched unrelated brands sharing a word fragment ("ClickHouse
// Cloud" rendered Cloudflare's logo via "cloud"). A missed match is recoverable
// (the cascade falls through to the domain-derived integrations.sh favicon,
// which is always the right brand); a wrong-brand icon is not.
export function integrationPresetIconUrl(
  integration: {
    readonly id: string;
    readonly kind: string;
    readonly name?: string;
    readonly url?: string;
  },
  integrationPlugins: readonly IntegrationPlugin[],
): string | null {
  const pluginKey = KIND_TO_PLUGIN_KEY[integration.kind] ?? integration.kind;
  const plugin = integrationPlugins.find((p) => p.key === pluginKey);
  const presets = plugin?.presets ?? [];
  const exactSlugIcon = presets.find((p) => p.defaultSlug === integration.id)?.icon;
  if (exactSlugIcon) return exactSlugIcon;

  const integrationUrl = normalizeUrl(integration.url);
  const integrationGoogleService = googleApiServiceFromUrl(integration.url);

  const preset = presets.find((p) => {
    const presetUrl = normalizeUrl(p.url);
    const presetGoogleService = googleApiServiceFromUrl(p.url);
    return (
      (integrationUrl !== null && presetUrl === integrationUrl) ||
      (integrationGoogleService !== null && presetGoogleService === integrationGoogleService)
    );
  });

  return preset?.icon ?? null;
}

// Resolution cascade for the rendered favicon: first non-null, non-failed of an
// explicit preset icon, its explicit fallback image, the bundled local icon for
// a known integration id, then the integrations.sh logo proxy derived from the
// integration URL (which owns its own upstream fallbacks). The built-in executor
// integration has no preset icon and no URL, so it resolves ONLY through the
// integrationId branch: callers that drop integrationId fall through to the
// neutral BoxIcon placeholder.
export function integrationFaviconSrc(args: {
  icon?: string | null;
  fallbackSrc?: string | null;
  integrationId?: string;
  url?: string;
  size: number;
  failedSrcs?: readonly string[];
}): string | null {
  const failedSrcs = args.failedSrcs ?? [];
  return (
    [
      args.icon ?? null,
      args.fallbackSrc ?? null,
      integrationLocalIconUrl(args.integrationId),
      integrationFaviconUrl(args.url, args.size),
    ].find((candidate) => candidate !== null && !failedSrcs.includes(candidate)) ?? null
  );
}

export function IntegrationFavicon({
  icon,
  fallbackSrc,
  integrationId,
  url,
  size = 16,
  className,
}: {
  icon?: string | null;
  fallbackSrc?: string | null;
  integrationId?: string;
  url?: string;
  size?: number;
  className?: string;
}) {
  const [failedSrcs, setFailedSrcs] = useState<readonly string[]>([]);
  // `executor:`-scheme icons (served by the local API behind the bearer gate,
  // e.g. a Codex plugin's own icon) resolve asynchronously to a data URI; a
  // null resolution marks the candidate failed so the cascade continues.
  const [executorIcons, setExecutorIcons] = useState<Readonly<Record<string, string>>>({});
  const cascadeSrc = integrationFaviconSrc({
    icon,
    fallbackSrc,
    integrationId,
    url,
    size,
    failedSrcs,
  });
  const isExecutorSrc = cascadeSrc?.startsWith(EXECUTOR_ICON_SCHEME) ?? false;

  useEffect(() => {
    if (!isExecutorSrc || cascadeSrc === null) return;
    let live = true;
    void resolveExecutorIcon(cascadeSrc.slice(EXECUTOR_ICON_SCHEME.length)).then((resolvedIcon) => {
      if (!live) return;
      if (resolvedIcon === null) {
        setFailedSrcs((current) =>
          current.includes(cascadeSrc) ? current : [...current, cascadeSrc],
        );
      } else {
        setExecutorIcons((current) => ({ ...current, [cascadeSrc]: resolvedIcon }));
      }
    });
    return () => {
      live = false;
    };
  }, [isExecutorSrc, cascadeSrc]);

  const src =
    cascadeSrc === null ? null : isExecutorSrc ? (executorIcons[cascadeSrc] ?? null) : cascadeSrc;

  if (!src) {
    return (
      <BoxIcon
        aria-hidden
        className={cn("shrink-0 text-muted-foreground", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  // On error, fail the CASCADE candidate (the `executor:` string for resolved
  // icons), not the rendered data URI, so the cascade actually advances.
  const failedCandidate = cascadeSrc ?? src;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() =>
        setFailedSrcs((current) =>
          current.includes(failedCandidate) ? current : [...current, failedCandidate],
        )
      }
      className={cn("shrink-0 rounded-sm object-contain", className)}
      style={{ width: size, height: size }}
    />
  );
}
