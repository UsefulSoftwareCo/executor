import { contextBridge, ipcRenderer } from "electron";
import {
  desktopBridgeVersion,
  type DesktopAccount,
  type DesktopHostBridge,
  desktopHostBridgeGlobal,
} from "../../../../packages/apps/src/contracts/desktop.ts";
import { type BridgeReply, desktopChannels } from "./contracts/bridge-channels.ts";

const server: unknown = ipcRenderer.sendSync(desktopChannels.hostServer);

const call = <A>(request: Record<string, unknown>): Promise<A> =>
  ipcRenderer.invoke(desktopChannels.hostCall, request).then((reply: BridgeReply<A>) => {
    if (reply.ok) return reply.value;
    throw reply.failure;
  });

const listeners = new Set<(account: DesktopAccount) => void>();
ipcRenderer.on(desktopChannels.hostAccount, (_event, account: DesktopAccount) => {
  for (const listener of listeners) listener(account);
});

const installedListeners = new Set<(app: string) => void>();
ipcRenderer.on(desktopChannels.hostInstalled, (_event, app: string) => {
  for (const listener of installedListeners) listener(app);
});

if (typeof server === "string") {
  const bridge: DesktopHostBridge = {
    version: desktopBridgeVersion,
    server,
    installed: (app) => call({ method: "installed", app }),
    install: (app) => call({ method: "install", app }),
    uninstall: (app) => call({ method: "uninstall", app }),
    open: (app) => call({ method: "open", app }),
    permissions: (app) => call({ method: "permissions", app }),
    setPermission: (app, name, state) => call({ method: "setPermission", app, name, state }),
    account: () => call({ method: "account" }),
    watchAccount: (listener) => {
      const own = (account: DesktopAccount) => listener(account);
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },
    watchInstalled: (listener) => {
      const own = (app: string) => listener(app);
      installedListeners.add(own);
      return () => {
        installedListeners.delete(own);
      };
    },
    openAccountMenu: (options) =>
      call({ method: "accountMenu", anchor: options.anchor, settings: options.settings }),
  };
  contextBridge.exposeInMainWorld(desktopHostBridgeGlobal, Object.freeze(bridge));
}
