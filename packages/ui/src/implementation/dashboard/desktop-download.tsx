import { useEffect, useState } from "react";
import {
  assetUrl,
  type DesktopDownloadOs,
  type DesktopDownloadTarget,
  type DesktopReleaseSource,
  detectDesktopOs,
  fetchNewestRelease,
} from "../../contracts/desktop-download.ts";
import { cn } from "../lib/utils.ts";

const dashboardButton =
  "inline-flex items-center justify-center gap-[0.4rem] rounded-[8px] border border-border bg-background px-[1.25rem] py-[0.7rem] text-[14.5px] font-medium tracking-[-0.005em] text-foreground transition-[background,border-color] hover:border-muted-foreground hover:bg-accent";
const dashboardOther =
  "relative self-center [&_>_summary]:cursor-pointer [&_>_summary]:list-none [&_>_summary]:select-none [&_>_summary]:text-[13px] [&_>_summary]:text-muted-foreground [&_>_summary:hover]:text-foreground [&_>_summary::-webkit-details-marker]:hidden [&[open]_>_summary]:text-foreground";
const dashboardOtherList =
  "absolute top-[calc(100%+0.5rem)] left-1/2 z-20 flex min-w-[16rem] -translate-x-1/2 flex-col gap-px rounded-[12px] border bg-popover p-[0.45rem] shadow-md [&_a]:block [&_a]:rounded-[8px] [&_a]:px-[0.8rem] [&_a]:py-[0.55rem] [&_a]:text-left [&_a]:text-[13.5px] [&_a]:text-muted-foreground [&_a:hover]:bg-accent [&_a:hover]:text-foreground";

export function DesktopDownload({
  targets,
  fallback,
  source,
  className,
  buttonClassName = dashboardButton,
  otherClassName = dashboardOther,
  otherListClassName = dashboardOtherList,
}: {
  readonly targets: ReadonlyArray<DesktopDownloadTarget>;
  readonly fallback: string;
  readonly source?: DesktopReleaseSource;
  readonly className?: string;
  readonly buttonClassName?: string;
  readonly otherClassName?: string;
  readonly otherListClassName?: string;
}) {
  const [links, setLinks] = useState<Readonly<Record<string, string>>>({});
  const [detected, setDetected] = useState<DesktopDownloadOs | null>(null);
  useEffect(() => {
    let current = true;
    void detectDesktopOs().then((os) => {
      if (current && targets.some((target) => target.os === os)) setDetected(os);
    });
    if (source !== undefined)
      void fetchNewestRelease(source)
        .catch(() => null)
        .then((release) => {
          if (!current || release === null) return;
          setLinks(
            Object.fromEntries(
              targets.flatMap((target) => {
                const url = assetUrl(release, target.asset);
                return url === null ? [] : [[target.asset, url] as const];
              }),
            ),
          );
        });
    return () => {
      current = false;
    };
  }, [source, targets]);
  const others = detected === null ? [] : targets.filter((target) => target.os !== detected);
  return (
    <span
      className={cn("inline-flex flex-wrap items-center gap-[0.5rem_0.75rem]", className)}
      data-download
      data-releases-api={source?.releasesApi}
      data-tag-prefix={source?.tagPrefix}
      data-stable-only={source === undefined ? undefined : String(source.stableOnly)}
    >
      {targets.map((target) => {
        const hidden = detected !== null && target.os !== detected;
        return (
          <a
            key={target.os}
            data-os={target.os}
            data-asset={target.asset}
            href={links[target.asset] ?? fallback}
            className={cn(buttonClassName, hidden && "hidden")}
            inert={hidden}
          >
            {target.label}
          </a>
        );
      })}
      <details className={cn(otherClassName, detected === null && "hidden")} data-download-other>
        <summary>Other platforms ▾</summary>
        <div className={otherListClassName} data-download-other-list>
          {others.map((target) => (
            <a key={target.os} href={links[target.asset] ?? fallback}>
              {target.label}
            </a>
          ))}
        </div>
      </details>
    </span>
  );
}
