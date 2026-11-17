import { useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download04Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Button } from "@executor-js/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@executor-js/ui/components/tooltip";
import { useSidebarCollapsed } from "@executor-js/ui/dashboard/shell";
import {
  DesktopUpdate,
  desktopUpdateAttribute,
  desktopUpdateEvent,
  desktopUpdateRestartUrl,
} from "../contracts/desktop-update.ts";

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopUpdate));

const subscribe = (listener: () => void) => {
  window.addEventListener(desktopUpdateEvent, listener);
  return () => window.removeEventListener(desktopUpdateEvent, listener);
};
const snapshot = () => document.documentElement.getAttribute(desktopUpdateAttribute);

/** The update the desktop app has told this dashboard about; none outside the desktop. */
export function useDesktopUpdate() {
  const value = useSyncExternalStore(subscribe, snapshot, () => null);
  return value === null ? Option.none<DesktopUpdate>() : decode(value);
}

/**
 * The desktop app's update, as the sidebar's card above its links: what it downloads, then a
 * button that restarts Executor into it. The icon rail shows the same as an icon with a tooltip.
 * On a short window the card drops its description, and the sidebar scrolls as it always has.
 */
export function DesktopUpdateCard({ update }: { readonly update: DesktopUpdate }) {
  const collapsed = useSidebarCollapsed();
  const version = `v${update.version}`;
  const restart = `Restart Executor to install ${version}`;
  if (collapsed)
    return (
      <div className="sidebar-update flex justify-center">
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              {update.state === "ready" ? (
                <Button asChild variant="outline" size="icon-sm">
                  <a href={desktopUpdateRestartUrl} aria-label={restart}>
                    <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} size={15} aria-hidden />
                  </a>
                </Button>
              ) : (
                <span
                  role="status"
                  aria-label={`Downloading ${version}`}
                  tabIndex={0}
                  className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <HugeiconsIcon icon={Download04Icon} strokeWidth={2} size={15} aria-hidden />
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="right">
              {update.state === "ready" ? restart : `Downloading ${version}`}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  if (update.state === "downloading")
    return (
      <div
        role="status"
        className="sidebar-update flex items-start gap-2 rounded-lg border bg-card px-2.5 py-2 text-[12px] text-muted-foreground"
      >
        <HugeiconsIcon icon={Download04Icon} strokeWidth={2} size={14} aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">Downloading {version}</span>
      </div>
    );
  return (
    <div className="sidebar-update grid gap-2 rounded-lg border bg-card p-2.5 text-foreground">
      <div className="grid gap-0.5">
        <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-[12px] font-medium leading-tight">
          <span>Update ready</span>
          <span className="min-w-0 font-mono text-[11px] font-normal text-muted-foreground [overflow-wrap:anywhere]">
            {version}
          </span>
        </p>
        <p className="text-[11px] leading-tight text-muted-foreground [@media(max-height:600px)]:hidden">
          Executor restarts to install it.
        </p>
      </div>
      <Button asChild variant="outline" size="xs" className="w-full">
        <a href={desktopUpdateRestartUrl} aria-label={restart}>
          <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} aria-hidden />
          Restart to update
        </a>
      </Button>
    </div>
  );
}

/**
 * Says once, to a screen reader, that the desktop's update is ready, whichever form the sidebar
 * shows it in. The region is always on the page, so the change into it is announced; it is empty
 * while there is nothing ready, as in any browser.
 */
export function DesktopUpdateAnnouncement({
  update,
}: {
  readonly update: Option.Option<DesktopUpdate>;
}) {
  const ready = Option.filter(update, (value) => value.state === "ready");
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="desktop-update-announcement sr-only"
    >
      {Option.isSome(ready) &&
        `Update ready: Executor v${ready.value.version}. Restart Executor to install it.`}
    </div>
  );
}
