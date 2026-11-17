/**
 * The desktop app's update, shown in the dashboard's sidebar. The desktop window has no preload
 * or IPC bridge, so its main process writes the update on the dashboard's document, as this
 * attribute's JSON, and announces each change with this event. The sidebar's action is a link to
 * `executor-update:restart`, which the main process intercepts as it does the recovery page's
 * links. A dashboard outside the desktop never gets the attribute and shows nothing.
 */
import { Schema } from "effect";

export const DesktopUpdate = Schema.Struct({
  /** `downloading` while the desktop fetches it; `ready` once a restart installs it. */
  state: Schema.Literals(["downloading", "ready"]),
  version: Schema.String,
});
export type DesktopUpdate = typeof DesktopUpdate.Type;

export const desktopUpdateAttribute = "data-desktop-update";
export const desktopUpdateEvent = "executor:desktop-update";
export const desktopUpdateRestartUrl = "executor-update:restart";

/**
 * The script the desktop runs in the dashboard's page to show `update`, or to clear it. The value
 * is JSON, written into the script as a string literal.
 */
export const desktopUpdateScript = (update: DesktopUpdate | undefined) =>
  `((value) => {
  const root = document.documentElement;
  if (value === null) root.removeAttribute(${JSON.stringify(desktopUpdateAttribute)});
  else root.setAttribute(${JSON.stringify(desktopUpdateAttribute)}, value);
  window.dispatchEvent(new Event(${JSON.stringify(desktopUpdateEvent)}));
})(${JSON.stringify(update === undefined ? null : JSON.stringify(update))});`;
