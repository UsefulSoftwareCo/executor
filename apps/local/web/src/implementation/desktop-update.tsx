import { useRef, useState, useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import { Download04Icon } from "@hugeicons/core-free-icons";
import { Button } from "@executor-js/ui/components/button";
import {
  NewsVersion,
  ReleaseNotesDialog,
  SidebarNews,
  sidebarNewsActionClass,
} from "@executor-js/ui/dashboard/sidebar-news";
import { releasePageUrl } from "@executor-js/utils/release-notes";
import {
  DesktopUpdate,
  desktopUpdateAttribute,
  desktopUpdateEvent,
  desktopUpdateRestartUrl,
  listsEverySince,
  releasesSince,
  runningRelease,
} from "../contracts/desktop-update.ts";

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopUpdate));

const subscribe = (listener: () => void) => {
  window.addEventListener(desktopUpdateEvent, listener);
  return () => window.removeEventListener(desktopUpdateEvent, listener);
};
const snapshot = () => document.documentElement.getAttribute(desktopUpdateAttribute);

export function useDesktopUpdate() {
  const value = useSyncExternalStore(subscribe, snapshot, () => null);
  return value === null ? Option.none<DesktopUpdate>() : decode(value);
}

export function DesktopUpdateBlock({ update }: { readonly update: DesktopUpdate }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (update.state === "downloading")
    return (
      <SidebarNews tag="Downloading" status>
        Version {update.version}
      </SidebarNews>
    );
  const restart = `Restart Executor to install v${update.version}`;
  const releases = update.releases === undefined ? undefined : releasesSince(update);
  const running = runningRelease(update);
  const newest = releases?.find((release) => release.version === update.version)?.notes[0];
  const line =
    newest === undefined ? (
      `Version ${update.version} is ready to install.`
    ) : (
      <>
        <NewsVersion version={update.version} /> {newest}
      </>
    );
  const action = (
    <a href={desktopUpdateRestartUrl} aria-label={restart} className={sidebarNewsActionClass}>
      Restart to update
    </a>
  );
  if (releases === undefined || releases.length === 0)
    return (
      <SidebarNews tag="Update ready" action={action}>
        {line}
      </SidebarNews>
    );
  return (
    <>
      <SidebarNews
        tag="Update ready"
        action={action}
        open={{ label: `See what's new in v${update.version}`, onOpen: () => setOpen(true) }}
        buttonRef={opener}
      >
        {line}
      </SidebarNews>
      <ReleaseNotesDialog
        open={open}
        onOpenChange={setOpen}
        returnFocus={opener}
        title={`What's new in v${update.version}`}
        description={
          running === undefined
            ? "Executor restarts to install it."
            : listsEverySince(update)
              ? `Changes since v${running}, the version running now. Executor restarts to install it.`
              : "Recent changes. Some releases since the version running now may not be listed here; All releases has every one. Executor restarts to install it."
        }
        releases={releases.map((release) => ({
          key: release.version,
          heading: `v${release.version}`,
          mono: true,
          notes: release.notes,
          url: {
            href: releasePageUrl(release.version),
            label: `Release page for v${release.version}`,
          },
        }))}
        more={{
          label: "All releases",
          url: "https://github.com/UsefulSoftwareCo/executor/releases",
        }}
        action={
          <Button asChild size="sm">
            <a href={desktopUpdateRestartUrl} aria-label={restart}>
              Restart to update
            </a>
          </Button>
        }
      />
    </>
  );
}

export const desktopUpdateMark = (update: DesktopUpdate) => ({
  label:
    update.state === "ready"
      ? `Update ready: version ${update.version}`
      : `Downloading version ${update.version}`,
  icon: Download04Icon,
  dot: update.state === "ready",
});

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
