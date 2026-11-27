import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { withApps } from "../support/apps-release.ts";

const files = [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({ react: "^19.2.0", "react-dom": "^19.2.0" }),
    }),
  },
  {
    path: "index.ts",
    content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Desktop client</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content: `import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  desktop,
  DesktopInvalidInput,
  DesktopPermissionDenied,
  DesktopUnavailable,
  ShortcutTaken,
  SystemAudioBlocked,
} from "apps/client";
import {
  useDesktopBadge,
  useDesktopPermission,
  useDesktopShortcut,
  useDesktopWindowEvent,
} from "apps/react";
const unhandled = [];
window.addEventListener("unhandledrejection", (event) => unhandled.push(named(event.reason)));
const named = (error) =>
  error instanceof DesktopUnavailable ? "DesktopUnavailable"
  : error instanceof DesktopPermissionDenied ? "DesktopPermissionDenied " + error.permission
  : error instanceof ShortcutTaken ? "ShortcutTaken " + error.accelerator
  : error instanceof DesktopInvalidInput ? "DesktopInvalidInput " + error.message
  : error instanceof SystemAudioBlocked ? "SystemAudioBlocked"
  : "unknown " + String(error);
const outcome = (promise) =>
  promise.then((value) => ({ value: value ?? null }), (error) => ({ error: named(error) }));
const presses = [];
const removers = new Map();
window.desktopProbe = {
  available: () => desktop.available,
  permission: (name) => outcome(desktop.permission(name)),
  setTitle: (text) => outcome(desktop.menuBar.setTitle(text)),
  setFloating: (on) => outcome(desktop.window.setFloating(on)),
  register: (accelerator) =>
    outcome(
      desktop.shortcuts.register(accelerator, () => presses.push(accelerator)).then((remove) => {
        removers.set(accelerator, remove);
        return "registered";
      }),
    ),
  unregister: (accelerator) => outcome(removers.get(accelerator)()),
  presses: () => presses,
  unhandled: () => unhandled,
  requestPermission: (name) => outcome(desktop.requestPermission(name)),
  windowAction: (action) => outcome(desktop.window[action]()),
  openWindow: (path, options) => outcome(desktop.window.open(path, options)),
  badge: (count) => outcome(desktop.badge.set(count)),
  systemAudio: () =>
    desktop.audio.system().then(
      (stream) => ({ value: stream.getTracks().map((track) => track.kind) }),
      (error) => ({ error: named(error) }),
    ),
  listen: () => {
    const stops = [
      desktop.window.onBlur(() => windowEvents.push("blur")),
      desktop.window.onFocus(() => windowEvents.push("focus")),
    ];
    return () => stops.forEach((stop) => stop());
  },
  windowEvents: () => windowEvents,
};
const windowEvents = [];
function Desktop() {
  const [count, setCount] = useState(4);
  const [blurs, setBlurs] = useState(0);
  const microphone = useDesktopPermission("microphone");
  const failure = useDesktopBadge(count);
  useDesktopWindowEvent("blur", () => setBlurs((value) => value + 1));
  return (
    <section>
      <p id="microphone">{microphone ?? "reading"}</p>
      <p id="badge-failure">{failure === undefined ? "none" : named(failure)}</p>
      <p id="blurs">{"blurs " + blurs}</p>
      <button onClick={() => setCount(9)}>Badge nine</button>
      <button onClick={() => setCount(100000)}>Badge too many</button>
    </section>
  );
}
function Shortcut({ accelerator, onPress }) {
  const failure = useDesktopShortcut(accelerator, onPress);
  return <p id="hook-failure">{failure === undefined ? "none" : named(failure)}</p>;
}
function App() {
  const [count, setCount] = useState(0);
  const [step, setStep] = useState(1);
  const [accelerator, setAccelerator] = useState("CommandOrControl+K");
  const [generation, setGeneration] = useState(0);
  const [held, setHeld] = useState(true);
  const [desktopShown, setDesktopShown] = useState(false);
  return (
    <main>
      <h1>Desktop client</h1>
      {desktopShown && <Desktop />}
      <button onClick={() => setDesktopShown(!desktopShown)}>
        {desktopShown ? "Hide desktop section" : "Show desktop section"}
      </button>
      <p role="status">{"presses " + count}</p>
      {held && (
        <Shortcut key={generation} accelerator={accelerator} onPress={() => setCount(count + step)} />
      )}
      <button onClick={() => setStep(10)}>Count by ten</button>
      <button onClick={() => setGeneration((value) => value + 1)}>Remount shortcut</button>
      <button onClick={() => setAccelerator("CommandOrControl+K")}>Use K</button>
      <button onClick={() => setAccelerator("Alt+Space")}>Use Alt+Space</button>
      <button onClick={() => setHeld(false)}>Release shortcut</button>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);`,
  },
];

const fakeAppBridge = () => {
  const calls: unknown[][] = [];
  const permissions: Record<string, string> = {
    menuBar: "granted",
    shortcuts: "prompt",
    floating: "denied",
    notifications: "unavailable",
    microphone: "granted",
    startAtLogin: "prompt",
  };
  let systemAudioBlocked = true;
  const displayTracks: MediaStreamTrack[] = [];
  Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
    configurable: true,
    value: (constraints: unknown) => {
      calls.push(["page", "getDisplayMedia", constraints]);
      const audio = new AudioContext().createMediaStreamDestination().stream.getAudioTracks();
      const canvas = document.createElement("canvas");
      const video = canvas.captureStream().getVideoTracks();
      displayTracks.push(...audio, ...video);
      return Promise.resolve(new MediaStream([...audio, ...video]));
    },
  });
  const held = new Map<string, string>();
  const takenElsewhere = new Set(["Alt+Space", "F13"]);
  const failingRemoval = new Set<string>();
  const duplicating = new Map<string, string>();
  let issued = 0;
  let pending = 0;
  let closed = false;
  const later = <A>(settle: () => A): Promise<A> => {
    pending += 1;
    return new Promise<A>((resolve, reject) =>
      setTimeout(() => {
        pending -= 1;
        if (closed) reject({ _tag: "DesktopUnavailable" });
        else
          try {
            resolve(settle());
          } catch (reason) {
            reject(reason);
          }
      }, 30),
    );
  };
  const idsOf = (accelerator: string) =>
    [...held].filter(([, value]) => value === accelerator).map(([id]) => id);
  const bridge = (label: string) =>
    Object.freeze({
      version: 1,
      permission: (name: string) => {
        calls.push([label, "permission", name]);
        return later(() => permissions[name]);
      },
      setMenuBarTitle: (text: string | null) => {
        calls.push([label, "setMenuBarTitle", text]);
        return later(() => {
          if (text?.includes("\n"))
            throw { _tag: "DesktopInvalidInput", message: "A menu-bar title is one line." };
        });
      },
      registerShortcut: (accelerator: string) => {
        calls.push([label, "registerShortcut", accelerator]);
        return later(() => {
          const duplicateOf = duplicating.get(accelerator);
          if (duplicateOf !== undefined) {
            duplicating.delete(accelerator);
            return { id: idsOf(duplicateOf)[0] };
          }
          if (takenElsewhere.has(accelerator) || idsOf(accelerator).length > 0)
            throw { _tag: "ShortcutTaken", accelerator };
          issued += 1;
          const id = `id-${issued}`;
          held.set(id, accelerator);
          return { id };
        });
      },
      unregisterShortcut: (id: string) => {
        calls.push([label, "unregisterShortcut", held.get(id) ?? id]);
        return later(() => {
          if (failingRemoval.delete(id)) throw { _tag: "DesktopUnavailable" };
          held.delete(id);
        });
      },
      setFloating: (on: boolean) => {
        calls.push([label, "setFloating", on]);
        return later(() => {
          if (on) throw { _tag: "DesktopPermissionDenied", permission: "floating" };
        });
      },
      requestPermission: (name: string) => {
        calls.push([label, "requestPermission", name]);
        return later(() => {
          if (permissions[name] === "prompt") permissions[name] = "granted";
          return permissions[name];
        });
      },
      windowAction: (action: string) => {
        calls.push([label, "windowAction", action]);
        return later(() => undefined);
      },
      openWindow: (path: string, options: unknown) => {
        calls.push([label, "openWindow", path, options]);
        return later(() => undefined);
      },
      setBadge: (count: number | null) => {
        calls.push([label, "setBadge", count]);
        return later(() => undefined);
      },
      systemAudio: () => {
        calls.push([label, "systemAudio"]);
        return later(() => {
          if (systemAudioBlocked) throw { _tag: "SystemAudioBlocked" };
        });
      },
    });
  Reflect.set(window, "desktopBridge", {
    calls: () => calls,
    settled: () => pending === 0,
    held: () => [...held.values()].sort(),
    press: (accelerator: string) => {
      for (const id of idsOf(accelerator))
        window.dispatchEvent(new CustomEvent("executor:desktop-shortcut", { detail: { id } }));
    },
    free: (accelerator: string) => takenElsewhere.delete(accelerator),
    failNextRemoval: (accelerator: string) => {
      for (const id of idsOf(accelerator)) failingRemoval.add(id);
    },
    duplicateNext: (accelerator: string, of: string) => duplicating.set(accelerator, of),
    replace: () => Reflect.set(window, "__executorDesktop", bridge("replacement")),
    close: () => {
      closed = true;
    },
    reopen: () => {
      closed = false;
      Reflect.set(window, "__executorDesktop", bridge("reopened"));
    },
    allowSystemAudio: () => {
      systemAudioBlocked = false;
    },
    windowEvent: (type: string) =>
      window.dispatchEvent(new CustomEvent("executor:desktop-window", { detail: { type } })),
    displayTracks: () => displayTracks.map((track) => `${track.kind} ${track.readyState}`),
  });
  Reflect.set(window, "__executorDesktop", bridge("first"));
};

layer(HostedLive, { excludeTestServices: true })("App desktop client", (it) => {
  it.effect(scenarios.appDesktopClient.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Desktop client ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/${app.id}/ui`);
        yield* browser.login(actors.owner);
        yield* openPrivateApp(url);
        yield* browser.use("The app page renders", (page) =>
          page.getByRole("heading", { name: "Desktop client" }).waitFor(),
        );

        const browserTab = yield* browser.use("Call desktop from a browser tab", (page) =>
          page
            .getByRole("button", { name: "Show desktop section" })
            .click()
            .then(() => page.locator("#microphone").filter({ hasText: "unavailable" }).waitFor())
            .then(() =>
              page.evaluate(() => {
                const probe = Reflect.get(window, "desktopProbe");
                return Promise.all([
                  probe.permission("menuBar"),
                  probe.setTitle("Hi"),
                  probe.register("CommandOrControl+Shift+P"),
                  probe.setFloating(true),
                  probe.requestPermission("microphone"),
                  probe.windowAction("focus"),
                  probe.openWindow("/compose", {}),
                  probe.badge(1),
                  probe.systemAudio(),
                ]).then(
                  ([
                    permission,
                    setTitle,
                    register,
                    setFloating,
                    requested,
                    focus,
                    open,
                    badge,
                    systemAudio,
                  ]) => ({
                    available: probe.available(),
                    permission,
                    setTitle,
                    register,
                    setFloating,
                    requested,
                    focus,
                    open,
                    badge,
                    systemAudio,
                    hook: document.querySelector("#hook-failure")?.textContent,
                    microphone: document.querySelector("#microphone")?.textContent,
                    badgeFailure: document.querySelector("#badge-failure")?.textContent,
                  }),
                );
              }),
            ),
        );
        expect(browserTab).toEqual({
          available: false,
          permission: { value: "unavailable" },
          setTitle: { error: "DesktopUnavailable" },
          register: { error: "DesktopUnavailable" },
          setFloating: { error: "DesktopUnavailable" },
          requested: { value: "unavailable" },
          focus: { error: "DesktopUnavailable" },
          open: { error: "DesktopUnavailable" },
          badge: { error: "DesktopUnavailable" },
          systemAudio: { error: "DesktopUnavailable" },
          hook: "none",
          microphone: "unavailable",
          badgeFailure: "none",
        });
        yield* browser.checkpoint("Outside the desktop the API reports itself unavailable");

        yield* browser.use(
          "Give the page a deferred, exclusive desktop bridge and reload",
          (page) =>
            page
              .context()
              .addInitScript(fakeAppBridge)
              .then(() => page.reload()),
        );
        const hookSettles = (
          description: string,
          held: readonly string[],
          failure: string | null,
        ) =>
          browser.use(description, (page) =>
            page.waitForFunction(
              ([held, failure]) => {
                const bridge = Reflect.get(window, "desktopBridge");
                return (
                  bridge.settled() &&
                  JSON.stringify(bridge.held()) === JSON.stringify(held) &&
                  (document.querySelector("#hook-failure")?.textContent ?? null) === failure
                );
              },
              [held, failure] as const,
            ),
          );
        const click = (name: string) =>
          browser.use(`Click ${name}`, (page) =>
            page.getByRole("button", { name, exact: true }).click(),
          );
        const press = (accelerator: string) =>
          browser.use(`Press ${accelerator}`, (page) =>
            page.evaluate(
              (accelerator) => Reflect.get(window, "desktopBridge").press(accelerator),
              accelerator,
            ),
          );
        const presses = (count: number) =>
          browser.use(`The page counted ${count}`, (page) =>
            page
              .getByRole("status")
              .filter({ hasText: `presses ${count}` })
              .waitFor(),
          );

        yield* hookSettles("The mounted hook holds its shortcut", ["CommandOrControl+K"], "none");
        yield* press("CommandOrControl+K");
        yield* presses(1);
        yield* press("CommandOrControl+K");
        yield* presses(2);
        yield* click("Count by ten");
        yield* press("CommandOrControl+K");
        yield* presses(12);

        yield* click("Remount shortcut");
        yield* hookSettles(
          "A remount in one commit releases the shortcut before taking it again",
          ["CommandOrControl+K"],
          "none",
        );
        yield* click("Use Alt+Space");
        yield* hookSettles(
          "A shortcut another program holds reports ShortcutTaken",
          [],
          "ShortcutTaken Alt+Space",
        );
        yield* browser.use("The other program lets Alt+Space go", (page) =>
          page.evaluate(() => Reflect.get(window, "desktopBridge").free("Alt+Space")),
        );
        yield* click("Use K");
        yield* hookSettles("Switching back holds K again", ["CommandOrControl+K"], "none");
        yield* click("Use Alt+Space");
        yield* hookSettles(
          "A new attempt at Alt+Space drops its earlier failure",
          ["Alt+Space"],
          "none",
        );
        yield* browser.use("The desktop refuses the next removal of Alt+Space", (page) =>
          page.evaluate(() => Reflect.get(window, "desktopBridge").failNextRemoval("Alt+Space")),
        );
        yield* click("Remount shortcut");
        yield* hookSettles(
          "The refused removal is retried before Alt+Space is taken again",
          ["Alt+Space"],
          "none",
        );
        yield* click("Use K");
        yield* hookSettles("The hook holds K", ["CommandOrControl+K"], "none");
        yield* press("CommandOrControl+K");
        yield* presses(22);
        yield* click("Release shortcut");
        yield* hookSettles("Unmounting releases the shortcut", [], null);
        yield* press("CommandOrControl+K");

        const hookCalls = yield* browser.use("Read the hook's bridge calls", (page) =>
          page.evaluate(() => ({
            calls: Reflect.get(window, "desktopBridge").calls(),
            unhandled: Reflect.get(window, "desktopProbe").unhandled(),
            status: document.querySelector("[role=status]")?.textContent,
          })),
        );
        expect(hookCalls).toEqual({
          calls: [
            ["first", "registerShortcut", "CommandOrControl+K"],
            ["first", "unregisterShortcut", "CommandOrControl+K"],
            ["first", "registerShortcut", "CommandOrControl+K"],
            ["first", "unregisterShortcut", "CommandOrControl+K"],
            ["first", "registerShortcut", "Alt+Space"],
            ["first", "registerShortcut", "CommandOrControl+K"],
            ["first", "unregisterShortcut", "CommandOrControl+K"],
            ["first", "registerShortcut", "Alt+Space"],
            ["first", "unregisterShortcut", "Alt+Space"],
            ["first", "unregisterShortcut", "Alt+Space"],
            ["first", "registerShortcut", "Alt+Space"],
            ["first", "unregisterShortcut", "Alt+Space"],
            ["first", "registerShortcut", "CommandOrControl+K"],
            ["first", "unregisterShortcut", "CommandOrControl+K"],
          ],
          unhandled: [],
          status: "presses 22",
        });
        yield* browser.checkpoint("The hook serializes, retries and calls the latest handler");

        const installed = yield* browser.use("Call desktop in an installed window", (page) =>
          page.evaluate(() => {
            const probe = Reflect.get(window, "desktopProbe");
            return Promise.all([
              probe.permission("shortcuts"),
              probe.setTitle("3 unread"),
              probe.setTitle(null),
              probe.setTitle("x".repeat(25)),
              probe.setTitle("two\nlines"),
              probe.setFloating(true),
              probe.setFloating(false),
              probe.register("F13"),
              probe.register("CommandOrControl+Shift+P"),
            ]).then(
              ([
                permission,
                setTitle,
                restore,
                tooLong,
                twoLines,
                floating,
                unfloat,
                taken,
                register,
              ]) => ({
                available: probe.available(),
                permission,
                setTitle,
                restore,
                tooLong,
                twoLines,
                floating,
                unfloat,
                taken,
                register,
              }),
            );
          }),
        );
        expect(installed).toEqual({
          available: true,
          permission: { value: "prompt" },
          setTitle: { value: null },
          restore: { value: null },
          tooLong: { error: "DesktopInvalidInput A menu-bar title can be at most 24 characters." },
          twoLines: { error: "DesktopInvalidInput A menu-bar title is one line." },
          floating: { error: "DesktopPermissionDenied floating" },
          unfloat: { value: null },
          taken: { error: "ShortcutTaken F13" },
          register: { value: "registered" },
        });

        const probe = <A>(description: string, run: () => Promise<A>) =>
          browser.use(description, (page) => page.evaluate(run));
        const duplicate = yield* probe<{ readonly error?: string }>(
          "Register a shortcut the desktop gives a held ID",
          () => {
            Reflect.get(window, "desktopBridge").duplicateNext(
              "CommandOrControl+Shift+D",
              "CommandOrControl+Shift+P",
            );
            return Reflect.get(window, "desktopProbe").register("CommandOrControl+Shift+D");
          },
        );
        expect(duplicate.error).toMatch(
          /^unknown Error: The desktop gave the shortcut CommandOrControl\+Shift\+D the ID id-\d+, which another registration in this page already holds\.$/u,
        );
        yield* press("CommandOrControl+Shift+P");
        const refused = yield* probe("Remove the shortcut while the desktop refuses", () => {
          Reflect.get(window, "desktopBridge").failNextRemoval("CommandOrControl+Shift+P");
          return Reflect.get(window, "desktopProbe").unregister("CommandOrControl+Shift+P");
        });
        expect(refused).toEqual({ error: "DesktopUnavailable" });
        yield* press("CommandOrControl+Shift+P");
        yield* probe("Register a shortcut to remove after the bridge is replaced", () =>
          Reflect.get(window, "desktopProbe").register("CommandOrControl+Shift+Q"),
        );
        const retried = yield* probe("Replace the bridge, then remove both shortcuts", () => {
          Reflect.get(window, "desktopBridge").replace();
          const probe = Reflect.get(window, "desktopProbe");
          return Promise.all([
            probe.unregister("CommandOrControl+Shift+P"),
            probe.unregister("CommandOrControl+Shift+Q"),
            probe.permission("menuBar"),
          ]);
        });
        expect(retried).toEqual([{ value: null }, { value: null }, { value: "granted" }]);
        yield* press("CommandOrControl+Shift+P");
        yield* press("CommandOrControl+Shift+Q");
        const closed = yield* probe("Call desktop after the desktop closes the bridge", () => {
          Reflect.get(window, "desktopBridge").close();
          return Reflect.get(window, "desktopProbe").setTitle("closed");
        });
        expect(closed).toEqual({ error: "DesktopUnavailable" });

        const recorded = yield* browser.use("Read the bridge calls and presses", (page) =>
          page.evaluate(() => ({
            presses: Reflect.get(window, "desktopProbe").presses(),
            unhandled: Reflect.get(window, "desktopProbe").unhandled(),
            calls: Reflect.get(window, "desktopBridge").calls().slice(14),
            held: Reflect.get(window, "desktopBridge").held(),
          })),
        );
        expect(recorded).toEqual({
          presses: ["CommandOrControl+Shift+P", "CommandOrControl+Shift+P"],
          unhandled: [],
          held: [],
          calls: [
            ["first", "permission", "shortcuts"],
            ["first", "setMenuBarTitle", "3 unread"],
            ["first", "setMenuBarTitle", null],
            ["first", "setMenuBarTitle", "two\nlines"],
            ["first", "setFloating", true],
            ["first", "setFloating", false],
            ["first", "registerShortcut", "F13"],
            ["first", "registerShortcut", "CommandOrControl+Shift+P"],
            ["first", "registerShortcut", "CommandOrControl+Shift+D"],
            ["first", "unregisterShortcut", "CommandOrControl+Shift+P"],
            ["first", "registerShortcut", "CommandOrControl+Shift+Q"],
            ["first", "unregisterShortcut", "CommandOrControl+Shift+P"],
            ["first", "unregisterShortcut", "CommandOrControl+Shift+Q"],
            ["replacement", "permission", "menuBar"],
            ["replacement", "setMenuBarTitle", "closed"],
          ],
        });
        yield* browser.checkpoint("The client maps bridge calls, shortcut events and failures");

        const before = yield* probe<number>("Reopen the bridge", () => {
          Reflect.get(window, "desktopBridge").reopen();
          return Reflect.get(window, "desktopBridge").calls().length;
        });
        const capabilities = yield* probe(
          "Call the window, badge, audio and permission API",
          () => {
            const probe = Reflect.get(window, "desktopProbe");
            const bridge = Reflect.get(window, "desktopBridge");
            const stop = probe.listen();
            bridge.windowEvent("blur");
            bridge.windowEvent("focus");
            bridge.windowEvent("resize");
            stop();
            bridge.windowEvent("blur");
            return Promise.all([
              probe.windowAction("show"),
              probe.windowAction("hide"),
              probe.windowAction("focus"),
              probe.windowAction("toggle"),
              probe.openWindow("/compose?to=ada", { width: 420, floating: true }),
              probe.openWindow("https://example.com/", {}),
              probe.openWindow("//example.com/", {}),
              probe.badge(3),
              probe.badge(null),
              probe.badge(-1),
              probe.badge(1.5),
              probe.badge(100000),
              probe.requestPermission("startAtLogin"),
              probe.systemAudio(),
            ]).then((results) => {
              bridge.allowSystemAudio();
              return probe.systemAudio().then((audio: unknown) => ({
                results,
                audio,
                tracks: bridge.displayTracks(),
                events: probe.windowEvents(),
              }));
            });
          },
        );
        const invalidPath = (path: string) => ({
          error: `DesktopInvalidInput ${path} is not a path on this app, such as /notes/42.`,
        });
        const invalidBadge = {
          error: "DesktopInvalidInput A badge is a whole number from 0 to 99999.",
        };
        expect(capabilities).toEqual({
          results: [
            { value: null },
            { value: null },
            { value: null },
            { value: null },
            { value: null },
            invalidPath("https://example.com/"),
            invalidPath("//example.com/"),
            { value: null },
            { value: null },
            invalidBadge,
            invalidBadge,
            invalidBadge,
            { value: "granted" },
            { error: "SystemAudioBlocked" },
          ],
          audio: { value: ["audio"] },
          tracks: ["audio live", "video ended"],
          events: ["blur", "focus"],
        });

        yield* browser.use("Mount the desktop hooks", (page) =>
          page
            .getByRole("button", { name: "Show desktop section" })
            .click()
            .then(() => page.locator("#microphone").filter({ hasText: "granted" }).waitFor()),
        );
        yield* browser.use("Badge nine, then too many", (page) =>
          page
            .getByRole("button", { name: "Badge nine" })
            .click()
            .then(() => page.getByRole("button", { name: "Badge too many" }).click())
            .then(() =>
              page
                .locator("#badge-failure")
                .filter({ hasText: "DesktopInvalidInput A badge is a whole number" })
                .waitFor(),
            ),
        );
        yield* browser.use("The window loses focus", (page) =>
          page
            .evaluate(() => Reflect.get(window, "desktopBridge").windowEvent("blur"))
            .then(() => page.locator("#blurs").filter({ hasText: "blurs 1" }).waitFor()),
        );
        yield* browser.use(
          "The window regains focus, and the hook reads its permission again",
          (page) =>
            page
              .evaluate(() => Reflect.get(window, "desktopBridge").windowEvent("focus"))
              .then(() =>
                page.waitForFunction(
                  () =>
                    Reflect.get(window, "desktopBridge")
                      .calls()
                      .filter(
                        (call: unknown[]) => call[1] === "permission" && call[2] === "microphone",
                      ).length === 2,
                ),
              ),
        );
        yield* browser.use("Unmount the desktop hooks", (page) =>
          page
            .getByRole("button", { name: "Hide desktop section" })
            .click()
            .then(() => page.waitForFunction(() => Reflect.get(window, "desktopBridge").settled())),
        );
        const reopened = yield* probe<ReadonlyArray<unknown>>("Read the new bridge calls", () =>
          Reflect.get(window, "desktopBridge").calls(),
        );
        expect(reopened.slice(before)).toEqual([
          ["reopened", "windowAction", "show"],
          ["reopened", "windowAction", "hide"],
          ["reopened", "windowAction", "focus"],
          ["reopened", "windowAction", "toggle"],
          ["reopened", "openWindow", "/compose?to=ada", { width: 420, floating: true }],
          ["reopened", "setBadge", 3],
          ["reopened", "setBadge", null],
          ["reopened", "requestPermission", "startAtLogin"],
          ["reopened", "systemAudio"],
          ["reopened", "systemAudio"],
          ["page", "getDisplayMedia", { audio: true, video: true }],
          ["reopened", "permission", "microphone"],
          ["reopened", "setBadge", 4],
          ["reopened", "setBadge", 9],
          ["reopened", "permission", "microphone"],
          ["reopened", "setBadge", null],
        ]);
        yield* browser.checkpoint("The client maps window, badge, audio and permission calls");
      }),
    ),
  );
});
