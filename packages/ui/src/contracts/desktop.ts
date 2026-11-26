import { Data, Effect, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  desktopBridgeVersion,
  desktopHostBridgeGlobal,
  type DesktopAccount,
  type DesktopAccountMenuOptions,
  type DesktopHostBridge,
  type DesktopPermission,
  type DesktopPermissionState,
} from "apps/ui/contracts";
import { acknowledge, acknowledgedQuery } from "./mutations.ts";
import { browserOnly } from "./http.ts";

const hostMethods = [
  "installed",
  "install",
  "uninstall",
  "open",
  "permissions",
  "setPermission",
] as const;
const isHostBridge = (value: unknown): value is DesktopHostBridge =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "version") === desktopBridgeVersion &&
  typeof Reflect.get(value, "server") === "string" &&
  hostMethods.every((method) => typeof Reflect.get(value, method) === "function");

export const currentDesktopHost = (): DesktopHostBridge | undefined => {
  const value =
    typeof window === "undefined" ? undefined : Reflect.get(window, desktopHostBridgeGlobal);
  return isHostBridge(value) ? value : undefined;
};

export class DesktopHostFailed extends Schema.TaggedError<DesktopHostFailed>()(
  "DesktopHostFailed",
  {
    action: Schema.Literals(["read", "install", "uninstall", "open", "permission", "account"]),
  },
) {}
export const desktopHostFailure = (error: DesktopHostFailed) => {
  switch (error.action) {
    case "read":
      return "Could not read this app from the Executor desktop app.";
    case "install":
      return "Could not install this app.";
    case "uninstall":
      return "Could not uninstall this app.";
    case "open":
      return "Could not open this app.";
    case "permission":
      return "Could not change this permission.";
    case "account":
      return "The Executor desktop app could not change this account. Try again.";
  }
};

export class DesktopAppKey extends Data.Class<{
  readonly server: string;
  readonly app: string;
}> {}

const host = <A>(
  action: DesktopHostFailed["action"],
  run: (bridge: DesktopHostBridge) => Promise<A>,
) =>
  Effect.tryPromise({
    try: () => {
      const bridge = currentDesktopHost();
      return bridge === undefined ? Promise.reject(new Error("No desktop bridge")) : run(bridge);
    },
    catch: () => new DesktopHostFailed({ action }),
  });

const installedChanges = Atom.family((app: string) =>
  Atom.make((get) => {
    const stop = currentDesktopHost()?.watchInstalled?.((changed) => {
      if (changed === app) get.setSelf(Option.getOrElse(get.self<number>(), () => 0) + 1);
    });
    if (stop !== undefined) get.addFinalizer(stop);
    return 0;
  }),
);
export const desktopInstalledAtom = Atom.family((key: DesktopAppKey) =>
  acknowledgedQuery(
    browserOnly(
      Atom.make((get) => {
        get(installedChanges(key.app));
        return host("read", (bridge) => bridge.installed(key.app));
      }),
    ),
  ),
);
export const desktopPermissionsAtom = Atom.family((key: DesktopAppKey) =>
  acknowledgedQuery(
    browserOnly(
      Atom.make((get) => {
        get(installedChanges(key.app));
        return host("read", (bridge) => bridge.permissions(key.app));
      }),
    ),
  ),
);

export const desktopInstallAtom = Atom.family((key: DesktopAppKey) =>
  Atom.fn((_: void, get) =>
    host("install", (bridge) => bridge.install(key.app)).pipe(
      Effect.tap((installed) =>
        Effect.sync(() => {
          if (installed === null) return;
          acknowledge(get, desktopInstalledAtom(key), () => installed);
          get.registry.refresh(desktopPermissionsAtom(key));
        }),
      ),
    ),
  ),
);
export const desktopUninstallAtom = Atom.family((key: DesktopAppKey) =>
  Atom.fn((_: void, get) =>
    host("uninstall", (bridge) => bridge.uninstall(key.app)).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          acknowledge(get, desktopInstalledAtom(key), () => null);
          get.registry.refresh(desktopPermissionsAtom(key));
        }),
      ),
    ),
  ),
);
export const desktopOpenAtom = Atom.family((key: DesktopAppKey) =>
  Atom.fn(() => host("open", (bridge) => bridge.open(key.app))),
);

export type DesktopPermissionChoice = Exclude<DesktopPermissionState, "unavailable">;
class PermissionKey extends Data.Class<{
  readonly server: string;
  readonly app: string;
  readonly permission: DesktopPermission;
}> {}
const permissionAtom = Atom.family((key: PermissionKey) =>
  Atom.fn((state: DesktopPermissionChoice, get) => {
    const app = new DesktopAppKey({ server: key.server, app: key.app });
    return host("permission", (bridge) =>
      bridge.setPermission(key.app, key.permission, state),
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() =>
          acknowledge(get, desktopPermissionsAtom(app), (current) => ({
            ...current,
            [key.permission]: result,
          })),
        ),
      ),
    );
  }),
);
export const desktopSetPermissionAtom = (key: DesktopAppKey, permission: DesktopPermission) =>
  permissionAtom(new PermissionKey({ server: key.server, app: key.app, permission }));

export const desktopPermissionLabels: Record<
  DesktopPermission,
  { readonly name: string; readonly description: string }
> = {
  menuBar: {
    name: "Menu bar",
    description: "Show the app's menu-bar page and set the text beside its icon.",
  },
  shortcuts: {
    name: "Keyboard shortcuts",
    description: "Respond to global keyboard shortcuts, even when another app is in front.",
  },
  floating: {
    name: "Float above other windows",
    description: "Keep the app's window in front of other windows.",
  },
  startAtLogin: {
    name: "Start at login",
    description: "Open without a window when you log in to this computer.",
  },
  microphone: {
    name: "Microphone",
    description: "Record from your microphone.",
  },
  camera: {
    name: "Camera",
    description: "Record from your camera.",
  },
  systemAudio: {
    name: "System audio",
    description: "Hear audio playing on this computer, such as a call.",
  },
  clipboardRead: {
    name: "Read clipboard",
    description: "Read text you copy, in any app.",
  },
  notifications: {
    name: "Notifications",
    description: "Show system notifications.",
  },
};

export const desktopDownloadPage = "https://executor.sh/#install";

export type DesktopDownloadPlatform = "mac" | "windows";
export const desktopPlatformOf = (userAgent: string): DesktopDownloadPlatform | "other" => {
  if (/\b(?:iPhone|iPad|iPod|Android|CrOS)\b/u.test(userAgent)) return "other";
  if (/\bWindows\b/u.test(userAgent)) return "windows";
  if (/\bMacintosh\b/u.test(userAgent)) return "mac";
  return "other";
};

type AccountBridge = Required<
  Pick<DesktopHostBridge, "account" | "watchAccount" | "openAccountMenu">
>;
const isAccountBridge = (bridge: DesktopHostBridge): bridge is DesktopHostBridge & AccountBridge =>
  typeof bridge.account === "function" &&
  typeof bridge.watchAccount === "function" &&
  typeof bridge.openAccountMenu === "function";

export const currentDesktopAccount = (): AccountBridge | undefined => {
  const bridge = currentDesktopHost();
  return bridge !== undefined && isAccountBridge(bridge) ? bridge : undefined;
};

export const desktopAccountAtom = browserOnly(
  Atom.make((get) => {
    const bridge = currentDesktopAccount();
    if (bridge === undefined) return Effect.fail(new DesktopHostFailed({ action: "read" }));
    get.addFinalizer(
      bridge.watchAccount((account: DesktopAccount) => get.setSelf(AsyncResult.success(account))),
    );
    return Effect.tryPromise({
      try: () => bridge.account(),
      catch: () => new DesktopHostFailed({ action: "read" }),
    });
  }),
);

export const desktopAccountMenuAtom = Atom.fn((options: DesktopAccountMenuOptions) =>
  Effect.tryPromise({
    try: () => {
      const bridge = currentDesktopAccount();
      return bridge === undefined
        ? Promise.reject(new Error("No desktop bridge"))
        : bridge.openAccountMenu(options);
    },
    catch: () => new DesktopHostFailed({ action: "account" }),
  }),
);
