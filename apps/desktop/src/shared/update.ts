// Wire contract for the desktop auto-update status the main process pushes to
// the renderer (and the renderer's "install now" request back). The web shell
// shows a desktop-native UpdateCard from this instead of the npm command it
// shows on web/CLI installs, because the desktop updates via electron-updater
// (GitHub releases, swapped in place), not `npm i -g`.
//
// The renderer carries a structurally identical view of this union at
// `@executor-js/react/hooks/desktop-update` (the IPC boundary is plain JSON, so
// each side owns its own copy rather than reaching across package roots).

export type DesktopUpdateStatus =
  | { readonly state: "idle" }
  | { readonly state: "available"; readonly version: string }
  | { readonly state: "downloading"; readonly version: string; readonly percent: number }
  | { readonly state: "downloaded"; readonly version: string }
  | { readonly state: "installing"; readonly version: string };

/** Push channel: main → renderer, whenever the update status changes. */
export const UPDATE_STATUS_CHANNEL = "executor:updates:status" as const;
/** Invoke channel: renderer → main, read the current status once on mount. */
export const UPDATE_STATUS_GET_CHANNEL = "executor:updates:status:get" as const;
/** Invoke channel: renderer → main, apply a downloaded update and restart. */
export const UPDATE_INSTALL_CHANNEL = "executor:updates:quit-and-install" as const;
