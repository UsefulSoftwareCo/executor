import { BoxIcon } from "lucide-react";
import { useState } from "react";
import { getDomain } from "tldts";

// ---------------------------------------------------------------------------
// SourceFavicon — renders a small favicon derived from a source URL.
// Falls back to a neutral icon if the URL is missing or the image fails to load.
// ---------------------------------------------------------------------------

export function sourceFaviconUrl(url: string | undefined, size: number): string | null {
  if (!url) return null;
  const domain = getDomain(url) ?? (URL.canParse(url) ? getDomain(new URL(url).hostname) : null);
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size * 2}`;
}

export function SourceFavicon({ url, size = 16 }: { url?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : sourceFaviconUrl(url, size);

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
      onError={() => setFailed(true)}
      className="shrink-0 rounded-sm"
      style={{ width: size, height: size }}
    />
  );
}
