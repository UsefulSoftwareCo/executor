import { useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import { Download04Icon } from "@hugeicons/core-free-icons";
import { SidebarNews, sidebarNewsActionClass } from "@executor-js/ui/dashboard/sidebar-news";
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
 * The desktop app's update as the sidebar's news block above its links: while it downloads, a
 * "Downloading" tag and its version; once it is ready, an "Update ready" tag, a line naming the
 * version and a "Restart to update" link that restarts Executor into it. The shell shows it in
 * place of the sidebar's resource links, and `desktopUpdateMark` in the icon rail; the app's Updates
 * menu offers the same restart.
 */
export function DesktopUpdateBlock({ update }: { readonly update: DesktopUpdate }) {
  if (update.state === "downloading")
    return (
      <SidebarNews tag="Downloading" status>
        Version {update.version}
      </SidebarNews>
    );
  return (
    <SidebarNews
      tag="Update ready"
      action={
        <a
          href={desktopUpdateRestartUrl}
          aria-label={`Restart Executor to install v${update.version}`}
          className={sidebarNewsActionClass}
        >
          Restart to update
        </a>
      }
    >
      Version {update.version} is ready to install.
    </SidebarNews>
  );
}

/**
 * The update's mark in the icon rail, which expands the rail to the block: a download icon, with a
 * dot once the update is ready to install.
 */
export const desktopUpdateMark = (update: DesktopUpdate) => ({
  label:
    update.state === "ready"
      ? `Update ready: version ${update.version}`
      : `Downloading version ${update.version}`,
  icon: Download04Icon,
  dot: update.state === "ready",
});

/**
 * Says once, to a screen reader, that the desktop's update is ready, also when the sidebar is the
 * icon rail, which has no block. The region is always on the page, so the change into it is
 * announced; it is empty while there is nothing ready, as in any browser.
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
