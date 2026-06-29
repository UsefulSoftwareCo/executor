// The sidebar "update available" card, shared by both shells (the local/desktop
// single-user shell in @executor-js/app and the multiplayer shell here). One
// `<SidebarUpdateCard />` encapsulates the whole decision, because the right way
// to upgrade depends on how this build was deployed:
//
//   - desktop app (the bridge is present): a native "Restart to update" action
//     wired to electron-updater (see ../hooks/desktop-update);
//   - npm-installed CLI / its local web UI (`VITE_UPGRADE_HINT === "npm"`): the
//     copyable `npm i -g executor@latest` command;
//   - self-host and Cloudflare (`"selfhost"` / `"cloudflare"`): a link to that
//     host's upgrade guide, because the steps (image pull, rebuild, redeploy)
//     vary too much for one correct command;
//   - managed cloud (`"managed"`): nothing, it deploys itself.
//
// The "is a newer version published?" verdict comes from the same resolver as
// the CLI notice (@executor-js/api) so the two can never disagree.
import { useCallback, useEffect, useState } from "react";

import { Effect, Exit } from "effect";
import { compareVersions, resolveUpdateChannel, type UpdateChannel } from "@executor-js/api";

import { Button } from "./button";
import { toast } from "./sonner";
import { copyToClipboard } from "../lib/clipboard";
import { type DesktopUpdate, useDesktopUpdate } from "../hooks/desktop-update";

const EXECUTOR_DIST_TAGS_PATH = "/v1/app/npm/dist-tags";
const DOCS_BASE_URL = "https://executor.sh/docs";

type UpgradeHint = "npm" | "selfhost" | "cloudflare" | "managed";

const appEnv = (
  import.meta as ImportMeta & {
    readonly env?: { readonly VITE_APP_VERSION?: string; readonly VITE_UPGRADE_HINT?: string };
  }
).env;
const APP_VERSION = appEnv?.VITE_APP_VERSION;
const UPGRADE_HINT = appEnv?.VITE_UPGRADE_HINT as UpgradeHint | undefined;

// Per-host upgrade guide. A host without an entry (or no hint at all) falls back
// to the docs root rather than a command, so a missing hint can never show a
// wrong upgrade step.
const UPGRADE_DOCS_URL: Partial<Record<UpgradeHint, string>> = {
  selfhost: `${DOCS_BASE_URL}/hosted/docker`,
  cloudflare: `${DOCS_BASE_URL}/hosted/cloudflare`,
};

// ── useLatestVersion ────────────────────────────────────────────────────

function useLatestVersion(currentVersion: string | undefined) {
  const channel: UpdateChannel = currentVersion ? resolveUpdateChannel(currentVersion) : "latest";
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!currentVersion) return;
    let cancelled = false;
    void Effect.runPromiseExit(
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(EXECUTOR_DIST_TAGS_PATH);
          if (!res.ok) return null;
          return (await res.json()) as Partial<Record<UpdateChannel, string>>;
        },
        catch: (cause) => cause,
      }),
    ).then((exit) => {
      if (!cancelled && Exit.isSuccess(exit)) {
        setLatestVersion(exit.value?.[channel] ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [channel, currentVersion]);

  const updateAvailable =
    currentVersion !== undefined &&
    latestVersion !== null &&
    compareVersions(currentVersion, latestVersion) === -1;

  return { latestVersion, updateAvailable, channel };
}

// ── Card chrome ──────────────────────────────────────────────────────────

/** The bordered card with the download glyph + "Update available" + version.
 *  Each variant supplies its own action as children. */
function UpdateCardShell(props: { version: string | null; children?: React.ReactNode }) {
  return (
    <div className="mx-2 mb-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-3">
      <div className="flex items-center gap-2">
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <svg viewBox="0 0 16 16" fill="none" className="size-3 text-primary">
            <path
              d="M8 3v7M5 7l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">Update available</p>
          {props.version && <p className="text-sm text-muted-foreground">v{props.version}</p>}
        </div>
      </div>
      {props.children}
    </div>
  );
}

// ── NpmUpdateCard (npm-installed CLI: copyable command) ───────────────────

function NpmUpdateCard(props: { latestVersion: string; channel: UpdateChannel }) {
  const command = `npm i -g executor@${props.channel}`;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void copyToClipboard(command).then((ok) => {
      if (!ok) {
        toast.error("Failed to copy to clipboard");
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [command]);

  return (
    <UpdateCardShell version={props.latestVersion}>
      <Button
        type="button"
        variant="outline"
        onClick={handleCopy}
        className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-lg border-border/60 bg-background/50 px-2.5 py-1.5 text-left hover:bg-background/80"
      >
        <code className="truncate font-mono text-xs text-sidebar-foreground">{command}</code>
        <span className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground">
          {copied ? (
            <svg viewBox="0 0 16 16" fill="none" className="size-3 text-primary">
              <path
                d="M3 8.5l3.5 3.5L13 4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="size-3">
              <rect
                x="5"
                y="5"
                width="8"
                height="8"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M3 11V3.5A.5.5 0 013.5 3H11"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </span>
      </Button>
    </UpdateCardShell>
  );
}

// ── LinkUpdateCard (self-host / Cloudflare: link to the upgrade guide) ────

function LinkUpdateCard(props: { latestVersion: string; href: string }) {
  return (
    <UpdateCardShell version={props.latestVersion}>
      <a
        href={props.href}
        target="_blank"
        rel="noreferrer"
        className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/50 px-2.5 py-1.5 text-xs text-sidebar-foreground transition-colors hover:bg-background/80 hover:text-foreground"
      >
        <span>Upgrade guide</span>
        <svg viewBox="0 0 16 16" fill="none" className="size-3 shrink-0">
          <path
            d="M4 12L12 4M6 4h6v6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>
    </UpdateCardShell>
  );
}

// ── DesktopUpdateCard (desktop app: native restart action) ────────────────

function DesktopUpdateCard(props: { update: DesktopUpdate }) {
  const { status, install } = props.update;
  const version = "version" in status ? status.version : null;

  const action = (() => {
    if (status.state === "downloaded") {
      return (
        <Button
          type="button"
          variant="outline"
          onClick={install}
          className="mt-2.5 w-full rounded-lg border-border/60 bg-background/50 px-2.5 py-1.5 text-xs hover:bg-background/80"
        >
          Restart to update
        </Button>
      );
    }
    if (status.state === "downloading") {
      return (
        <p className="mt-2.5 text-xs text-muted-foreground tabular-nums">
          Downloading… {status.percent}%
        </p>
      );
    }
    if (status.state === "available") {
      return <p className="mt-2.5 text-xs text-muted-foreground">Preparing update…</p>;
    }
    if (status.state === "installing") {
      return <p className="mt-2.5 text-xs text-muted-foreground">Restarting…</p>;
    }
    return null;
  })();

  return <UpdateCardShell version={version}>{action}</UpdateCardShell>;
}

// ── SidebarUpdateCard (the only export the shells consume) ────────────────

/**
 * The sidebar update card, or null when no update is available (or the host
 * manages its own updates). Reads `VITE_APP_VERSION` / `VITE_UPGRADE_HINT` and
 * the desktop bridge itself, so a shell just drops it in above its footer. Hook
 * order is stable across renders.
 */
export function SidebarUpdateCard(): React.ReactElement | null {
  const desktopUpdate = useDesktopUpdate();
  const { latestVersion, updateAvailable, channel } = useLatestVersion(APP_VERSION);

  // The desktop app updates via electron-updater, so its native card wins
  // wherever the bridge is present (it loads the local app UI, whose hint is
  // "npm" — the bridge overrides it).
  if (desktopUpdate) {
    return desktopUpdate.status.state !== "idle" ? (
      <DesktopUpdateCard update={desktopUpdate} />
    ) : null;
  }

  if (!updateAvailable || !latestVersion) return null;
  // Managed cloud deploys itself: knowing a version exists is not actionable.
  if (UPGRADE_HINT === "managed") return null;
  // The npm-installed CLI is the only deployment a command actually upgrades.
  if (UPGRADE_HINT === "npm") {
    return <NpmUpdateCard latestVersion={latestVersion} channel={channel} />;
  }
  // Self-host / Cloudflare (and any host without an explicit hint): link to the
  // upgrade guide rather than risk a wrong command.
  const href = (UPGRADE_HINT && UPGRADE_DOCS_URL[UPGRADE_HINT]) ?? DOCS_BASE_URL;
  return <LinkUpdateCard latestVersion={latestVersion} href={href} />;
}
