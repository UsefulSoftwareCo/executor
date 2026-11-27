import { Option, Schema } from "effect";
import {
  desktopBadgeMaximum,
  desktopMenuBarTitleMaxLength,
  desktopWindowSize,
  type DesktopPermission,
} from "../../../../../packages/apps/src/contracts/desktop.ts";

export const DesktopId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u));
export const AccountKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,128}(?:\.[A-Za-z0-9_-]{1,128})?$/u),
);
export type AccountKey = typeof AccountKey.Type;

export const PermissionName = Schema.Literals([
  "menuBar",
  "shortcuts",
  "floating",
  "startAtLogin",
  "microphone",
  "camera",
  "systemAudio",
  "clipboardRead",
  "notifications",
]);
export const PermissionDecision = Schema.Literals(["granted", "denied"]);
export type PermissionDecision = typeof PermissionDecision.Type;
export const PermissionSetting = Schema.Literals(["granted", "denied", "prompt"]);

export const WindowBounds = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type WindowBounds = typeof WindowBounds.Type;

export const InstalledApp = Schema.Struct({
  server: AccountKey,
  app: DesktopId,
  installation: Schema.String.check(Schema.isUUID()),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: Schema.String,
  origin: Schema.String,
  icon: Schema.String,
  launcher: Schema.NullOr(Schema.String),
  installedAt: Schema.String,
  permissions: Schema.Struct({
    menuBar: Schema.optionalKey(PermissionDecision),
    shortcuts: Schema.optionalKey(PermissionDecision),
    floating: Schema.optionalKey(PermissionDecision),
    startAtLogin: Schema.optionalKey(PermissionDecision),
    microphone: Schema.optionalKey(PermissionDecision),
    camera: Schema.optionalKey(PermissionDecision),
    systemAudio: Schema.optionalKey(PermissionDecision),
    clipboardRead: Schema.optionalKey(PermissionDecision),
    notifications: Schema.optionalKey(PermissionDecision),
  }),
  bounds: Schema.optionalKey(WindowBounds),
});
export type InstalledApp = typeof InstalledApp.Type;

export const InstalledServer = Schema.Struct({
  apps: Schema.Record(Schema.String, InstalledApp),
});

export const InstalledAppsFile = Schema.Struct({
  version: Schema.Literal(1),
  servers: Schema.Record(Schema.String, InstalledServer),
});
export type InstalledAppsFile = typeof InstalledAppsFile.Type;
export const installedAppsFileName = "installed-apps.json";

export const ServerIdentity = Schema.Struct({
  serverId: DesktopId,
  kind: Schema.Literals(["local", "self-host", "cloud"]),
});

export const AppDetails = Schema.Struct({
  app: Schema.Struct({ id: DesktopId, name: Schema.String }),
  uiUrl: Schema.NullOr(Schema.String),
  uiIcon: Schema.Boolean,
  uiMenuBar: Schema.Boolean,
});
export type AppDetails = typeof AppDetails.Type;

export class AppUnavailable extends Schema.TaggedError<AppUnavailable>()("AppUnavailable", {
  reason: Schema.Literals(["signed-out", "gone", "offline"]),
}) {}

export class DesktopUnavailable extends Schema.TaggedError<DesktopUnavailable>()(
  "DesktopUnavailable",
  {},
) {}
export class DesktopPermissionDenied extends Schema.TaggedError<DesktopPermissionDenied>()(
  "DesktopPermissionDenied",
  { permission: PermissionName },
) {}
export class ShortcutTaken extends Schema.TaggedError<ShortcutTaken>()("ShortcutTaken", {
  accelerator: Schema.String,
}) {}
export class DesktopInvalidInput extends Schema.TaggedError<DesktopInvalidInput>()(
  "DesktopInvalidInput",
  { message: Schema.String },
) {}
export class SystemAudioBlocked extends Schema.TaggedError<SystemAudioBlocked>()(
  "SystemAudioBlocked",
  {},
) {}
export class InstalledAppsUnreadable extends Schema.TaggedError<InstalledAppsUnreadable>()(
  "InstalledAppsUnreadable",
  { file: Schema.String },
) {}
export const BridgeFailure = Schema.Union([
  DesktopUnavailable,
  DesktopPermissionDenied,
  ShortcutTaken,
  DesktopInvalidInput,
  SystemAudioBlocked,
]);
export type BridgeFailure = typeof BridgeFailure.Type;
export const BridgeFailureJson = Schema.toCodecJson(BridgeFailure);

const MenuCoordinate = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(-100_000),
  Schema.isLessThanOrEqualTo(100_000),
);
export const MenuAnchor = Schema.Struct({
  x: MenuCoordinate,
  y: MenuCoordinate,
  width: MenuCoordinate,
  height: MenuCoordinate,
});
export type MenuAnchor = typeof MenuAnchor.Type;

export const HostCall = Schema.Union([
  Schema.Struct({ method: Schema.Literal("account") }),
  Schema.Struct({
    method: Schema.Literal("accountMenu"),
    anchor: MenuAnchor,
    settings: Schema.Boolean,
  }),
  Schema.Struct({ method: Schema.Literal("installed"), app: DesktopId }),
  Schema.Struct({ method: Schema.Literal("install"), app: DesktopId }),
  Schema.Struct({ method: Schema.Literal("uninstall"), app: DesktopId }),
  Schema.Struct({ method: Schema.Literal("open"), app: DesktopId }),
  Schema.Struct({ method: Schema.Literal("permissions"), app: DesktopId }),
  Schema.Struct({
    method: Schema.Literal("setPermission"),
    app: DesktopId,
    name: PermissionName,
    state: PermissionSetting,
  }),
]);
export type HostCall = typeof HostCall.Type;

export const MenuBarTitle = Schema.NullOr(
  Schema.String.check(
    Schema.isMaxLength(desktopMenuBarTitleMaxLength),
    Schema.isPattern(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u),
  ),
);
export const Accelerator = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[\p{L}\p{N}+]+$/u),
);
export const maximumShortcuts = 8;

const shortcutModifiers = new Map([
  ["commandorcontrol", true],
  ["cmdorctrl", true],
  ["command", true],
  ["cmd", true],
  ["control", true],
  ["ctrl", true],
  ["alt", true],
  ["option", true],
  ["altgr", true],
  ["super", true],
  ["meta", true],
  ["shift", false],
]);
const keysWithoutModifier = new Set([
  ...Array.from({ length: 12 }, (_, index) => `f${index + 13}`),
  "medianexttrack",
  "mediaprevioustrack",
  "mediastop",
  "mediaplaypause",
  "volumeup",
  "volumedown",
  "volumemute",
]);

export const shortcutProblem = (accelerator: string) => {
  const parts = accelerator.split("+");
  const key = parts.at(-1)?.toLowerCase() ?? "";
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  if (
    key === "" ||
    shortcutModifiers.has(key) ||
    modifiers.some((part) => !shortcutModifiers.has(part)) ||
    new Set(modifiers).size !== modifiers.length
  )
    return `${accelerator} is not a keyboard shortcut the desktop understands. Write modifiers, then one key, joined by +, such as CommandOrControl+Shift+K.`;
  if (
    !keysWithoutModifier.has(key) &&
    !modifiers.some((part) => shortcutModifiers.get(part) === true)
  )
    return `${accelerator} would take a key away from typing in every other app. A global shortcut needs CommandOrControl, Control, Command, Alt or Super; Shift alone is not enough. Only F13 to F24 and media keys work alone.`;
  return undefined;
};
export const ShortcutId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u));

export const NotificationId = Schema.String.check(Schema.isUUID());
export const NotificationEvent = Schema.Literals(["show", "click", "close", "error"]);
export type NotificationEvent = typeof NotificationEvent.Type;

export const AppPath = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^\/(?!\/)[^\s\\#]*$/u),
);
const WindowSize = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(desktopWindowSize.minimum),
  Schema.isLessThanOrEqualTo(desktopWindowSize.maximum),
);
export const BadgeCount = Schema.NullOr(
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(desktopBadgeMaximum),
  ),
);

export const AppCall = Schema.Union([
  Schema.Struct({ method: Schema.Literal("permission"), name: PermissionName }),
  Schema.Struct({ method: Schema.Literal("requestPermission"), name: PermissionName }),
  Schema.Struct({ method: Schema.Literal("setMenuBarTitle"), text: MenuBarTitle }),
  Schema.Struct({ method: Schema.Literal("registerShortcut"), accelerator: Accelerator }),
  Schema.Struct({ method: Schema.Literal("unregisterShortcut"), id: ShortcutId }),
  Schema.Struct({ method: Schema.Literal("setFloating"), on: Schema.Boolean }),
  Schema.Struct({
    method: Schema.Literal("windowAction"),
    action: Schema.Literals(["show", "hide", "focus", "toggle"]),
  }),
  Schema.Struct({
    method: Schema.Literal("openWindow"),
    path: AppPath,
    options: Schema.Struct({
      width: Schema.optionalKey(WindowSize),
      height: Schema.optionalKey(WindowSize),
      floating: Schema.optionalKey(Schema.Boolean),
    }),
  }),
  Schema.Struct({ method: Schema.Literal("setBadge"), count: BadgeCount }),
  Schema.Struct({ method: Schema.Literal("systemAudio") }),
  Schema.Struct({
    method: Schema.Literal("notify"),
    id: NotificationId,
    title: Schema.String.check(Schema.isMaxLength(1000)),
    body: Schema.String.check(Schema.isMaxLength(4000)),
    tag: Schema.String.check(Schema.isMaxLength(1000)),
    silent: Schema.Boolean,
    path: Schema.NullOr(AppPath),
  }),
  Schema.Struct({ method: Schema.Literal("closeNotification"), id: NotificationId }),
  Schema.Struct({
    method: Schema.Literal("prepareCapture"),
    names: Schema.Array(Schema.Literals(["microphone", "camera"])).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(2),
    ),
  }),
]);
export type AppCall = typeof AppCall.Type;

export const appProtocol = "executor";
export const appLink = (server: string, app: string) =>
  `${appProtocol}://app/${encodeURIComponent(server)}/${encodeURIComponent(app)}`;
export const parseAppLink = (value: string) => {
  const url = URL.parse(value);
  if (
    url === null ||
    url.protocol !== `${appProtocol}:` ||
    url.hostname !== "app" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== ""
  )
    return undefined;
  const [, server, app, ...rest] = url.pathname.split("/");
  if (server === undefined || app === undefined) return undefined;
  const ids = Schema.decodeUnknownOption(Schema.Tuple([AccountKey, DesktopId]))([server, app]);
  if (Option.isNone(ids)) return undefined;
  const target = { server: ids.value[0], app: ids.value[1] };
  const tail = rest.join("/");
  if (tail === "" && url.search === "") return target;
  const path = Schema.decodeUnknownOption(AppPath)(`/${tail}${url.search}`);
  return Option.isSome(path) ? { ...target, path: path.value } : undefined;
};

export const permissionPrompt = (permission: DesktopPermission, platform: string): string => {
  switch (permission) {
    case "menuBar":
      return platform === "darwin"
        ? "wants to add an item to the menu bar."
        : "wants to add an icon to the notification area.";
    case "shortcuts":
      return "wants to use a keyboard shortcut that works while you are in other apps.";
    case "floating":
      return "wants to keep its window above other windows.";
    case "startAtLogin":
      return "wants to start when you log in to this computer.";
    case "microphone":
      return "wants to use your microphone.";
    case "camera":
      return "wants to use your camera.";
    case "systemAudio":
      return "wants to hear audio playing on this computer.";
    case "clipboardRead":
      return "wants to read what you copy.";
    case "notifications":
      return "wants to show notifications.";
  }
};

export const appSource = (name: string, team: string | undefined, host: string) =>
  team === undefined ? `${name} on ${host}` : `${name} · ${team} on ${host}`;

export const permissionChangeHint =
  "You can change this later in the app's menu or in its Desktop settings.";
export const permissionDetail = (permission: DesktopPermission, platform: string): string => {
  switch (permission) {
    case "systemAudio":
      return "For example the other people in a call. It can't see your screen.";
    case "startAtLogin":
      return `It opens without a window${platform === "darwin" ? ", in the menu bar" : ""} until you open it. ${permissionChangeHint}`;
    case "clipboardRead":
      return `It can read text you copy in any app, whenever it asks. ${permissionChangeHint}`;
    default:
      return permissionChangeHint;
  }
};
