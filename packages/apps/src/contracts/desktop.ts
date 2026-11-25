/**
 * Protocols between the Executor desktop app and the pages it shows. The desktop's preload exposes
 * each bridge as one frozen global, only in windows it owns, and checks the page's exact origin on
 * every call. Neither bridge carries credentials, file access or account choice.
 */

/**
 * A capability an installed app asks the person for, once, and keeps until they revoke it.
 * `microphone` and `camera` gate `navigator.mediaDevices.getUserMedia`, `clipboardRead` gates
 * `navigator.clipboard.readText()`, `systemAudio` gates `desktop.audio.system()`, and
 * `startAtLogin` opens the app hidden when the person signs in to their computer.
 */
export type DesktopPermission =
  | "menuBar"
  | "shortcuts"
  | "floating"
  | "startAtLogin"
  | "microphone"
  | "camera"
  | "systemAudio"
  | "clipboardRead"
  | "notifications";
/** Every `DesktopPermission`, in the order the desktop lists them. */
export const desktopPermissions: readonly DesktopPermission[] = [
  "menuBar",
  "shortcuts",
  "floating",
  "startAtLogin",
  "microphone",
  "camera",
  "systemAudio",
  "clipboardRead",
  "notifications",
];
/**
 * `prompt` asks on first use. `unavailable` means the page is not in an installed desktop window,
 * or this platform has no such capability: `systemAudio` needs macOS 13 or Windows, and
 * `startAtLogin` needs macOS, Windows or a Linux desktop that reads `~/.config/autostart`.
 */
export type DesktopPermissionState = "granted" | "denied" | "prompt" | "unavailable";

/** Failures a bridge call rejects with, as plain tagged objects that cross the preload boundary. */
export type DesktopBridgeFailure =
  | { readonly _tag: "DesktopUnavailable" }
  | { readonly _tag: "DesktopPermissionDenied"; readonly permission: DesktopPermission }
  | { readonly _tag: "ShortcutTaken"; readonly accelerator: string }
  | { readonly _tag: "DesktopInvalidInput"; readonly message: string }
  | { readonly _tag: "SystemAudioBlocked" };

/** Longest menu-bar title, in characters. */
export const desktopMenuBarTitleMaxLength = 24;
/** Largest count `setBadge` shows. */
export const desktopBadgeMaximum = 99_999;
/** Most extra windows one installed app holds open at once, besides its main window. */
export const desktopMaximumWindows = 8;
/** Smallest and largest size, in pixels, of a window `openWindow` opens. */
export const desktopWindowSize = { minimum: 200, maximum: 4096 } as const;

/** What a window `openWindow` opens looks like. Width and height default to 800 by 600. */
export interface DesktopWindowOptions {
  readonly width?: number;
  readonly height?: number;
  /** Keep the window above other windows. Needs the `floating` permission. */
  readonly floating?: boolean;
}
/** What happened to the window a page is in, as the `type` of a `desktopWindowEvent`. */
export type DesktopWindowEventType = "focus" | "blur";

/**
 * The bridge in an installed app window or menu-bar popover, at `window[desktopAppBridgeGlobal]`.
 * Authors use `desktop` from `apps/client`, which wraps it; they never read the global.
 * Notifications use the standard `Notification` API; the desktop asks for the `notifications`
 * permission in front of it.
 */
export interface DesktopAppBridge {
  readonly version: typeof desktopBridgeVersion;
  readonly permission: (name: DesktopPermission) => Promise<DesktopPermissionState>;
  /** Ask the person for a permission now if they have not answered, and resolve their choice. */
  readonly requestPermission: (name: DesktopPermission) => Promise<DesktopPermissionState>;
  /** Plain text up to `desktopMenuBarTitleMaxLength`; `null` restores the app's name. */
  readonly setMenuBarTitle: (text: string | null) => Promise<void>;
  /**
   * Register a global shortcut in Electron accelerator syntax. When pressed, the page receives a
   * `desktopShortcutEvent` `CustomEvent` on `window` whose `detail` is `{ id }`.
   */
  readonly registerShortcut: (accelerator: string) => Promise<{ readonly id: string }>;
  readonly unregisterShortcut: (id: string) => Promise<void>;
  readonly setFloating: (on: boolean) => Promise<void>;
  /**
   * The window the calling page is in: `show` makes it visible, `hide` hides it, `focus` shows it
   * and brings it in front of every other app's windows, and `toggle` hides it when it is visible
   * and focused and focuses it otherwise.
   */
  readonly windowAction: (action: "show" | "hide" | "focus" | "toggle") => Promise<void>;
  /**
   * Open another window of this app at a path on the app's own origin, or focus the window that
   * already shows it. The window has this bridge too and closes with the app.
   */
  readonly openWindow: (path: string, options: DesktopWindowOptions) => Promise<void>;
  /** A count from 1 to `desktopBadgeMaximum` on the app's icon; `null` or 0 removes it. */
  readonly setBadge: (count: number | null) => Promise<void>;
  /**
   * Ask for the `systemAudio` permission and check the computer lets Executor record what it
   * plays. Resolves when `getDisplayMedia` in this page will capture system audio.
   */
  readonly systemAudio: () => Promise<void>;
}
export const desktopAppBridgeGlobal = "__executorDesktop";
export const desktopShortcutEvent = "executor:desktop-shortcut";
/** Dispatched on `window` with `detail` `{ type: DesktopWindowEventType }`. */
export const desktopWindowEvent = "executor:desktop-window";
export const desktopBridgeVersion = 1;

/**
 * `executor://app/<server>/<app>` opens an installed app; a path and query after the app's ID,
 * such as `executor://app/<server>/<app>/notes/42?tab=edit`, open it at that path on its origin.
 * A notification an app shows with `new Notification(title, { data: { path } })` opens that path
 * the same way when the person clicks it.
 */
export const desktopNotificationPathKey = "path";

/**
 * An app on one account the desktop holds. `server` is the account's `id` (`DesktopAccount`): the
 * server's ID from `/.well-known/executor` for this computer, `<server ID>.<organization ID>` for a
 * team on a hosted server. App links use it as their `<server>` segment.
 */
export interface DesktopAppRef {
  readonly server: string;
  readonly app: string;
}
export interface DesktopInstalledApp extends DesktopAppRef {
  readonly name: string;
  readonly installedAt: string;
}

/**
 * The account a desktop dashboard window belongs to: this computer's own Executor, or one team on
 * a hosted server. `id` is the server's ID for this computer and `<server ID>.<organization ID>` for
 * a team, so several teams on one server are separate accounts.
 */
export interface DesktopAccount {
  readonly id: string;
  readonly kind: "local" | "self-host" | "cloud";
  readonly team: string;
  readonly host: string;
  /**
   * `sign-in-again`: its sign-in ended and its apps stay closed until it signs in again.
   * `unreachable`: its server did not answer the last time the desktop asked.
   */
  readonly state: "signed-in" | "sign-in-again" | "unreachable";
}

/**
 * Where the dashboard's account button is, in CSS pixels of the page's viewport, so the desktop
 * shows its own account menu above it. `settings` adds Account settings to the menu.
 */
export interface DesktopAccountMenuOptions {
  readonly anchor: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly settings: boolean;
}

/**
 * The bridge in the desktop's dashboard windows, at `window[desktopHostBridgeGlobal]`. The shared
 * dashboard shows Install as app and the Desktop section only when it is present. `install` shows
 * the desktop's own confirmation dialog and resolves `null` when the person cancels.
 */
export interface DesktopHostBridge {
  readonly version: typeof desktopBridgeVersion;
  /** The account this dashboard window belongs to: a `DesktopAccount`'s `id`. */
  readonly server: string;
  readonly installed: (app: string) => Promise<DesktopInstalledApp | null>;
  readonly install: (app: string) => Promise<DesktopInstalledApp | null>;
  readonly uninstall: (app: string) => Promise<void>;
  readonly open: (app: string) => Promise<void>;
  readonly permissions: (app: string) => Promise<Record<DesktopPermission, DesktopPermissionState>>;
  /**
   * `denied` and `prompt` apply at once. `granted` shows the desktop's own permission prompt
   * first, so a page can't grant an app anything the person did not allow there. Resolves the
   * state the permission has afterwards.
   */
  readonly setPermission: (
    app: string,
    name: DesktopPermission,
    state: "granted" | "denied" | "prompt",
  ) => Promise<DesktopPermissionState>;
  /** This window's own account. Desktops before accounts lack the three account members. */
  readonly account?: () => Promise<DesktopAccount>;
  /** Calls `listener` with this window's account whenever it changes, until the returned function runs. */
  readonly watchAccount?: (listener: (account: DesktopAccount) => void) => () => void;
  /**
   * Calls `listener` with an app's ID whenever it is installed or removed on this desktop, however
   * that happened, until the returned function runs.
   */
  readonly watchInstalled?: (listener: (app: string) => void) => () => void;
  /**
   * Show the desktop's own account menu, which lists every account on this computer and switches,
   * adds, signs out of and removes them; the page never sees the other accounts. Resolves when the
   * menu closes: `settings` when the person chose Account settings, which the page then opens.
   */
  readonly openAccountMenu?: (options: DesktopAccountMenuOptions) => Promise<"settings" | null>;
}
export const desktopHostBridgeGlobal = "__executorDesktopHost";

/**
 * What `GET /.well-known/executor` answers on every Executor server, so a desktop can key it.
 * `origins` names where each role is served: the dashboard with sign-in and session links, the
 * API with its protected resource, and the OAuth issuer. One origin serves all three on local
 * and self-host; Cloud splits them across hosts.
 */
export interface ExecutorServerIdentity {
  readonly serverId: string;
  readonly kind: "local" | "self-host" | "cloud";
  readonly origins: {
    readonly dashboard: string;
    readonly api: string;
    readonly auth: string;
  };
}
export const executorServerIdentityPath = "/.well-known/executor";

/**
 * A browser dashboard's request that the desktop install one of its apps:
 * `executor://install?server=<dashboard origin>&app=<app ID>`, with `&org=<organization ID>` for a
 * hosted server. Any website can open such a link, so it carries no credential and grants
 * nothing: the desktop confirms the server's identity at `server` and shows its own install
 * dialog, and adding an unknown server shows the server form with that host first.
 */
export interface DesktopInstallLink {
  /** The dashboard's origin: `https://`, or `http://` on `localhost`, `127.0.0.1` or `[::1]`. */
  readonly server: string;
  readonly app: string;
  readonly organization?: string;
  /**
   * The app's and its team's names as the dashboard showed them, so a desktop that cannot read
   * them yet can say what the link asks. Any page can write them, so they only label a prompt.
   */
  readonly name?: string;
  readonly team?: string;
}
export const desktopLinkProtocol = "executor";
const installHost = "install";
const appIdPattern = /^app_[A-Za-z0-9_-]{1,124}$/u;
const organizationIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const labelPattern = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,80}$/u;
export const loopbackHostname = (hostname: string) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "[::1]" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname);

const dashboardOrigin = (value: string) => {
  const url = URL.parse(value);
  if (url === null || url.origin !== value) return undefined;
  if (url.protocol === "https:") return url.origin;
  return url.protocol === "http:" && loopbackHostname(url.hostname) ? url.origin : undefined;
};

/** Build an install link, or `undefined` when its parts would not parse back. */
export const desktopInstallLink = (link: DesktopInstallLink): string | undefined => {
  const params = new URLSearchParams({ server: link.server, app: link.app });
  if (link.organization !== undefined) params.set("org", link.organization);
  if (link.name !== undefined && labelPattern.test(link.name)) params.set("name", link.name);
  if (link.team !== undefined && labelPattern.test(link.team)) params.set("team", link.team);
  const value = `${desktopLinkProtocol}://${installHost}?${params.toString()}`;
  return parseDesktopInstallLink(value) === undefined ? undefined : value;
};

/** Read an install link strictly: any other part, repeated or unknown parameter is refused. */
export const parseDesktopInstallLink = (value: string): DesktopInstallLink | undefined => {
  const url = URL.parse(value);
  if (
    url === null ||
    url.protocol !== `${desktopLinkProtocol}:` ||
    url.hostname !== installHost ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  )
    return undefined;
  const keys = [...url.searchParams.keys()];
  const allowed = ["server", "app", "org", "name", "team"];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !allowed.includes(key)) ||
    !keys.includes("server") ||
    !keys.includes("app")
  )
    return undefined;
  const server = dashboardOrigin(url.searchParams.get("server") ?? "");
  const app = url.searchParams.get("app") ?? "";
  const organization = url.searchParams.get("org");
  const name = url.searchParams.get("name");
  const team = url.searchParams.get("team");
  if (server === undefined || !appIdPattern.test(app)) return undefined;
  if (organization !== null && !organizationIdPattern.test(organization)) return undefined;
  if ((name !== null && !labelPattern.test(name)) || (team !== null && !labelPattern.test(team)))
    return undefined;
  return {
    server,
    app,
    ...(organization === null ? {} : { organization }),
    ...(name === null ? {} : { name }),
    ...(team === null ? {} : { team }),
  };
};
