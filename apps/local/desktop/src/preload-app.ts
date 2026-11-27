import { contextBridge, ipcRenderer } from "electron";
import {
  type DesktopAppBridge,
  desktopAppBridgeGlobal,
  desktopBridgeVersion,
  desktopNotificationPathKey,
  desktopShortcutEvent,
  desktopWindowEvent,
} from "../../../../packages/apps/src/contracts/desktop.ts";
import { type BridgeReply, desktopChannels } from "./contracts/bridge-channels.ts";

const installed: unknown = ipcRenderer.sendSync(desktopChannels.appHello);

const call = <A>(request: Record<string, unknown>): Promise<A> =>
  ipcRenderer.invoke(desktopChannels.appCall, request).then((reply: BridgeReply<A>) => {
    if (reply.ok) return reply.value;
    throw reply.failure;
  });

if (installed === true) {
  const bridge: DesktopAppBridge = {
    version: desktopBridgeVersion,
    permission: (name) => call({ method: "permission", name }),
    requestPermission: (name) => call({ method: "requestPermission", name }),
    setMenuBarTitle: (text) => call({ method: "setMenuBarTitle", text }),
    registerShortcut: (accelerator) => call({ method: "registerShortcut", accelerator }),
    unregisterShortcut: (id) => call({ method: "unregisterShortcut", id }),
    setFloating: (on) => call({ method: "setFloating", on }),
    windowAction: (action) => call({ method: "windowAction", action }),
    openWindow: (path, options) =>
      call({
        method: "openWindow",
        path,
        options: {
          ...(options.width === undefined ? {} : { width: options.width }),
          ...(options.height === undefined ? {} : { height: options.height }),
          ...(options.floating === undefined ? {} : { floating: options.floating }),
        },
      }),
    setBadge: (count) => call({ method: "setBadge", count }),
    systemAudio: () => call({ method: "systemAudio" }),
  };
  contextBridge.exposeInMainWorld(desktopAppBridgeGlobal, Object.freeze(bridge));
  ipcRenderer.on(desktopChannels.appShortcut, (_event, id: unknown) => {
    if (typeof id !== "string") return;
    contextBridge.executeInMainWorld({
      func: (name: string, shortcut: string) =>
        window.dispatchEvent(new CustomEvent(name, { detail: { id: shortcut } })),
      args: [desktopShortcutEvent, id],
    });
  });
  ipcRenderer.on(desktopChannels.appWindowEvent, (_event, type: unknown) => {
    if (type !== "focus" && type !== "blur") return;
    contextBridge.executeInMainWorld({
      func: (name: string, kind: string) =>
        window.dispatchEvent(new CustomEvent(name, { detail: { type: kind } })),
      args: [desktopWindowEvent, type],
    });
  });
  contextBridge.executeInMainWorld({
    func: (prepare: (names: ReadonlyArray<string>) => Promise<boolean>) => {
      const original = MediaDevices.prototype.getUserMedia;
      Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
        value: function getUserMedia(this: MediaDevices, constraints?: MediaStreamConstraints) {
          const names = [
            ...(constraints?.audio ? ["microphone"] : []),
            ...(constraints?.video ? ["camera"] : []),
          ];
          if (names.length === 0) return original.call(this, constraints);
          return prepare(names).then((allowed) => {
            if (!allowed) throw new DOMException("Permission denied", "NotAllowedError");
            return original.call(this, constraints);
          });
        },
        writable: true,
        configurable: true,
      });
    },
    args: [
      (names: ReadonlyArray<string>) =>
        call<boolean>({ method: "prepareCapture", names }).catch(() => false),
    ],
  });
  const notificationListeners = new Set<(id: string, type: string) => void>();
  ipcRenderer.on(desktopChannels.appNotification, (_event, id: unknown, type: unknown) => {
    if (typeof id !== "string" || typeof type !== "string") return;
    for (const listener of notificationListeners) listener(id, type);
  });
  contextBridge.executeInMainWorld({
    func: (
      notify: (request: {
        id: string;
        title: string;
        body: string;
        tag: string;
        silent: boolean;
        path: string | null;
      }) => Promise<unknown>,
      close: (id: string) => void,
      listen: (listener: (id: string, type: string) => void) => void,
      pathKey: string,
    ) => {
      const Native = window.Notification;
      const handlers = ["show", "click", "close", "error"] as const;
      const shown = new Map<string, (type: (typeof handlers)[number]) => void>();
      class DesktopNotification extends EventTarget {
        static get permission() {
          return Native.permission;
        }
        static requestPermission(callback?: NotificationPermissionCallback) {
          return Native.requestPermission(callback);
        }
        readonly title: string;
        readonly body: string;
        readonly tag: string;
        readonly data: unknown;
        readonly silent: boolean | null;
        readonly icon: string;
        readonly lang: string;
        readonly dir: NotificationDirection;
        readonly #id = crypto.randomUUID();
        onshow: ((event: Event) => unknown) | null = null;
        onclick: ((event: Event) => unknown) | null = null;
        onclose: ((event: Event) => unknown) | null = null;
        onerror: ((event: Event) => unknown) | null = null;
        constructor(title: string, options: NotificationOptions = {}) {
          super();
          if (arguments.length === 0) throw new TypeError("Notification needs a title.");
          this.title = String(title);
          this.body = options.body === undefined ? "" : String(options.body);
          this.tag = options.tag === undefined ? "" : String(options.tag);
          this.data = options.data === undefined ? null : structuredClone(options.data);
          this.silent = options.silent ?? null;
          this.icon = options.icon === undefined ? "" : String(options.icon);
          this.lang = options.lang ?? "";
          this.dir = options.dir ?? "auto";
          const data: unknown = this.data;
          const path =
            typeof data === "object" && data !== null ? Reflect.get(data, pathKey) : undefined;
          if (Native.permission !== "granted") {
            queueMicrotask(() => this.#fire("error"));
            return;
          }
          shown.set(this.#id, (type) => this.#fire(type));
          notify({
            id: this.#id,
            title: this.title,
            body: this.body,
            tag: this.tag,
            silent: this.silent === true,
            path: typeof path === "string" ? path : null,
          }).catch(() => this.#fire("error"));
        }
        close() {
          close(this.#id);
        }
        #fire(type: (typeof handlers)[number]) {
          if (type === "close" || type === "error") shown.delete(this.#id);
          const event = new Event(type);
          const handler = this[`on${type}`];
          if (typeof handler === "function") handler.call(this, event);
          this.dispatchEvent(event);
        }
      }
      listen((id, type) => {
        const known = handlers.find((name) => name === type);
        if (known !== undefined) shown.get(id)?.(known);
      });
      Object.defineProperty(window, "Notification", {
        value: DesktopNotification,
        writable: true,
        configurable: true,
      });
    },
    args: [
      (request: Record<string, unknown>) => call({ method: "notify", ...request }),
      (id: string) => {
        void call({ method: "closeNotification", id }).catch(() => undefined);
      },
      (listener: (id: string, type: string) => void) => {
        notificationListeners.add(listener);
      },
      desktopNotificationPathKey,
    ],
  });
}
