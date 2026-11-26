/** Promise API over the desktop bridge of an installed app window. Runs only in the browser. */
import { Match, Option, Schema } from "effect";
import {
  desktopAppBridgeGlobal,
  desktopBadgeMaximum,
  desktopBridgeVersion,
  desktopMenuBarTitleMaxLength,
  desktopShortcutEvent,
  desktopWindowEvent,
  type DesktopAppBridge,
  type DesktopPermission,
  type DesktopPermissionState,
  type DesktopWindowEventType,
  type DesktopWindowOptions,
} from "../contracts/desktop.ts";
import {
  DesktopBridgeRejection,
  DesktopInvalidInput,
  DesktopPermissionDenied,
  DesktopUnavailable,
  ShortcutTaken,
  SystemAudioBlocked,
} from "../contracts/desktop-errors.ts";

const bridgeMethods = [
  "permission",
  "requestPermission",
  "setMenuBarTitle",
  "registerShortcut",
  "unregisterShortcut",
  "setFloating",
  "windowAction",
  "openWindow",
  "setBadge",
  "systemAudio",
] as const;
const isBridge = (value: unknown): value is DesktopAppBridge =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "version") === desktopBridgeVersion &&
  bridgeMethods.every((method) => typeof Reflect.get(value, method) === "function");
const currentBridge = (): DesktopAppBridge | undefined => {
  const value =
    typeof window === "undefined" ? undefined : Reflect.get(window, desktopAppBridgeGlobal);
  return isBridge(value) ? value : undefined;
};

const decodeRejection = Schema.decodeUnknownOption(DesktopBridgeRejection);
/** Turns a bridge's tagged rejection into its error class; any other value is rethrown unchanged. */
const typedRejection = (reason: unknown): unknown =>
  Option.match(decodeRejection(reason), {
    onNone: () => reason,
    onSome: Match.valueTags({
      DesktopUnavailable: () => new DesktopUnavailable(),
      DesktopPermissionDenied: ({ permission }) => new DesktopPermissionDenied({ permission }),
      ShortcutTaken: ({ accelerator }) => new ShortcutTaken({ accelerator }),
      DesktopInvalidInput: ({ message }) => new DesktopInvalidInput({ message }),
      SystemAudioBlocked: () => new SystemAudioBlocked(),
    }),
  });
const call = async <A>(run: (bridge: DesktopAppBridge) => Promise<A>): Promise<A> => {
  const bridge = currentBridge();
  if (bridge === undefined) throw new DesktopUnavailable();
  try {
    return await run(bridge);
  } catch (reason) {
    throw typedRejection(reason);
  }
};
const shortcutsByBridge = new WeakMap<DesktopAppBridge, Set<string>>();
const heldShortcuts = (bridge: DesktopAppBridge): Set<string> => {
  const held = shortcutsByBridge.get(bridge) ?? new Set<string>();
  shortcutsByBridge.set(bridge, held);
  return held;
};
const invalid = (message: string) => Promise.reject(new DesktopInvalidInput({ message }));
const windowEventType = (event: Event): DesktopWindowEventType | undefined => {
  if (!(event instanceof CustomEvent)) return undefined;
  const detail: unknown = event.detail;
  if (typeof detail !== "object" || detail === null) return undefined;
  const type: unknown = Reflect.get(detail, "type");
  return type === "focus" || type === "blur" ? type : undefined;
};
const onWindowEvent = (type: DesktopWindowEventType, handler: () => void): (() => void) => {
  if (currentBridge() === undefined) return () => undefined;
  const listener = (event: Event) => {
    if (windowEventType(event) === type) handler();
  };
  window.addEventListener(desktopWindowEvent, listener);
  return () => window.removeEventListener(desktopWindowEvent, listener);
};
const displayAudio = async (bridge: DesktopAppBridge): Promise<MediaStream> => {
  await bridge.systemAudio();
  const stream = await navigator.mediaDevices
    .getDisplayMedia({ audio: true, video: true })
    .catch(async (reason: unknown) => {
      await bridge.systemAudio();
      throw reason;
    });
  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }
  if (stream.getAudioTracks().length === 0) throw new DesktopUnavailable();
  return stream;
};

const shortcutId = (event: Event): string | undefined => {
  if (!(event instanceof CustomEvent)) return undefined;
  const detail: unknown = event.detail;
  if (typeof detail !== "object" || detail === null) return undefined;
  const id: unknown = Reflect.get(detail, "id");
  return typeof id === "string" ? id : undefined;
};

/**
 * Capabilities of the Executor desktop app, for a page shown in an installed app window or its
 * menu-bar popover. In any other page `available` is false, `permission` resolves `"unavailable"`
 * and every other call rejects with `DesktopUnavailable`. Calls that need a permission ask the
 * person the first time and reject with `DesktopPermissionDenied` when they decline.
 */
export const desktop = {
  /** Whether this page is in an installed Executor desktop window. */
  get available(): boolean {
    return currentBridge() !== undefined;
  },
  /** The person's choice for one capability, without asking them. */
  permission: (name: DesktopPermission): Promise<DesktopPermissionState> =>
    currentBridge() === undefined
      ? Promise.resolve("unavailable")
      : call((bridge) => bridge.permission(name)),
  /**
   * Ask the person for one capability now, if they have not answered yet, and resolve their
   * choice; a refusal resolves `"denied"` rather than rejecting. Use it for `startAtLogin`, which
   * no other call asks for, or to ask for the microphone before a recording starts.
   */
  requestPermission: (name: DesktopPermission): Promise<DesktopPermissionState> =>
    currentBridge() === undefined
      ? Promise.resolve("unavailable")
      : call((bridge) => bridge.requestPermission(name)),
  menuBar: {
    /**
     * Show plain text for the app in the menu bar, at most `desktopMenuBarTitleMaxLength`
     * characters. `null` restores the app's name. Needs the `menuBar` permission.
     */
    setTitle: (text: string | null): Promise<void> =>
      call((bridge) =>
        text !== null && text.length > desktopMenuBarTitleMaxLength
          ? Promise.reject(
              new DesktopInvalidInput({
                message: `A menu-bar title can be at most ${desktopMenuBarTitleMaxLength} characters.`,
              }),
            )
          : bridge.setMenuBarTitle(text),
      ),
  },
  shortcuts: {
    /**
     * Call `handler` whenever the person presses `accelerator` anywhere on their computer, in
     * Electron accelerator syntax such as `"CommandOrControl+Shift+K"`. Resolves a function that
     * removes the shortcut through the desktop window that registered it. The shortcut stays held,
     * and `handler` keeps running, until that function resolves; when it rejects, call it again.
     * Needs the `shortcuts` permission; rejects with `ShortcutTaken` when another program holds
     * the keys.
     */
    register: (accelerator: string, handler: () => void): Promise<() => Promise<void>> =>
      call(async (bridge) => {
        const { id } = await bridge.registerShortcut(accelerator);
        const held = heldShortcuts(bridge);
        if (held.has(id))
          throw new Error(
            `The desktop gave the shortcut ${accelerator} the ID ${id}, which another registration in this page already holds.`,
          );
        held.add(id);
        const listener = (event: Event) => {
          if (shortcutId(event) === id) handler();
        };
        window.addEventListener(desktopShortcutEvent, listener);
        let removal: Promise<void> | undefined;
        let removed = false;
        const unregister = async () => {
          try {
            await bridge.unregisterShortcut(id);
          } catch (reason) {
            throw typedRejection(reason);
          } finally {
            removal = undefined;
          }
          removed = true;
          held.delete(id);
          window.removeEventListener(desktopShortcutEvent, listener);
        };
        return () => {
          if (removed) return Promise.resolve();
          removal ??= unregister();
          return removal;
        };
      }),
  },
  window: {
    /** Keep the app's window above other windows, or stop. Needs the `floating` permission. */
    setFloating: (on: boolean): Promise<void> => call((bridge) => bridge.setFloating(on)),
    /** Make the window this page is in visible. */
    show: (): Promise<void> => call((bridge) => bridge.windowAction("show")),
    /** Hide the window this page is in. The app keeps running, and its page keeps running. */
    hide: (): Promise<void> => call((bridge) => bridge.windowAction("hide")),
    /**
     * Show the window this page is in and bring it in front of every other app's windows, such as
     * from a global shortcut's handler.
     */
    focus: (): Promise<void> => call((bridge) => bridge.windowAction("focus")),
    /** Hide the window when it is visible and focused; otherwise show and focus it. */
    toggle: (): Promise<void> => call((bridge) => bridge.windowAction("toggle")),
    /**
     * Open another window of this app at `path`, such as `"/compose?to=ada"`, on the app's own
     * origin, or focus the window that already shows that path. The window has `desktop` too, with
     * the same permissions, and closes when the app quits. At most `desktopMaximumWindows` are
     * open at once; `floating` needs the `floating` permission.
     */
    open: (path: string, options: DesktopWindowOptions = {}): Promise<void> =>
      call((bridge) =>
        path.startsWith("/") && !path.startsWith("//")
          ? bridge.openWindow(path, options)
          : invalid(`${path} is not a path on this app, such as /notes/42.`),
      ),
    /**
     * Call `handler` whenever the window this page is in loses focus, such as to hide a window a
     * shortcut summoned. Returns a function that stops listening. Does nothing outside an
     * installed Executor desktop window.
     */
    onBlur: (handler: () => void): (() => void) => onWindowEvent("blur", handler),
    /** Call `handler` whenever the window this page is in gains focus. */
    onFocus: (handler: () => void): (() => void) => onWindowEvent("focus", handler),
  },
  badge: {
    /**
     * Show a count on the app's icon: on Windows, on the app's own taskbar button; on macOS and
     * Linux, installed apps share Executor's Dock or launcher icon, which shows the sum of their
     * counts. `null` or 0 removes the app's count. Needs no permission.
     */
    set: (count: number | null): Promise<void> =>
      call((bridge) =>
        count === null || (Number.isInteger(count) && count >= 0 && count <= desktopBadgeMaximum)
          ? bridge.setBadge(count)
          : invalid(`A badge is a whole number from 0 to ${desktopBadgeMaximum}.`),
      ),
  },
  audio: {
    /**
     * Everything playing on this computer, such as the other people in a call, as an audio-only
     * `MediaStream`. Asks for the `systemAudio` permission the first time. Rejects with
     * `SystemAudioBlocked` when macOS has not allowed Executor to record the screen and system
     * audio, after offering to open System Settings, and with `DesktopUnavailable` where the
     * computer cannot capture system audio (Linux, macOS before 13). Stop its tracks when done.
     */
    system: (): Promise<MediaStream> => call(displayAudio),
  },
};
