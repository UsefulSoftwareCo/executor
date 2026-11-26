## Private app UI

Author app UIs as React SPAs. React is the only supported UI framework for now.
Add `ui/index.html`, a module script such as `ui/main.tsx`, and styles. The host
compiles browser assets alongside the server build. Declare `react` and
`react-dom` in the app's package dependencies. The local product opens
each configured app on its own localhost subdomain.

Use local React components or browser-compatible npm component libraries.
Declare library dependencies and include their required styles and assets.
Do not assume that the host runs custom build plugins required by a library.

Tailwind CSS v4 compilation is built in. Import `./style.css` from `ui/main.tsx`
and start the stylesheet with `@import "tailwindcss";`. No Tailwind dependency,
config file or build script is needed. Use complete class names in React code;
the build scans the browser bundle, including imported components and lazy
chunks. Customize tokens with CSS `@theme`. Use `@source inline("...")` for
classes supplied only at runtime. Do not use filesystem `@source` paths or
JavaScript `@config` and `@plugin` files. Plain CSS and library styles still work.
The full Tailwind import includes Preflight, which resets browser button and
form styles. Importing only `theme.css` and `utilities.css` omits those resets;
use that split only when you supply the required base styles yourself.

For hosted apps, discover and call `appUi.location` after deploying:

```js
return await tools.executor.appUi.location({
  path: { organization: "<approved-organization-id>", app: "<app-id>" },
});
```

The response is
`{ status: "ready", url: "https://<app-slug>.<org-slug>.executor.website", name, icon, menuBar }`
on Executor Cloud. Self-host uses its configured app domain. `name` is the
app's name for a window or launcher; `icon` and `menuBar` say whether the active
version has `ui/icon.svg` and `ui/menubar.html` (see Desktop app below). Use the returned
URL rather than constructing one. Before the first deploy it fails with
`AppNotDeployed`. `status: "unavailable"` has `url: null` and a `reason`:
`"no_ui"` when the active version has no UI, as for tool-only apps, or
`"no_app_domain"` when the host has no app domain (on self-host the operator
sets `EXECUTOR_APP_UI_BASE_URL`; a localhost dashboard needs none). `"pending"` and `"failed"`
report the setup of the team's app domain. Deploying builds and activates the UI;
there is no separate publish step. Give the URL to the user to open in a
browser. The browser completes sign-in using their Executor session. MCP
credentials do not grant a browser session. A `403` response alone does not
prove the URL is correct or that the UI renders; invalid hosts also return it.
Verify the actual page before claiming that the UI works.
Use an available authenticated browser session for that check. A fresh profile
may stop at sign-in. Successful tool calls or rows added by someone else do not
verify the page's layout, controls or optimistic interactions.

Import `createAppClient`, `queryReference`, and `mutationReference` from
`apps/client`. Import server operation **types only** from `index.ts`; put shared
schemas in a separate file. Use `client.queryAtom(reference, input, outputSchema)`
with `useAppQuery` from `apps/react`, and `client.mutate(reference, input,
outputSchema)` for explicit writes. `client.query(reference, input, outputSchema)`
reads once. Both operation types may fetch external APIs. External changes do
not invalidate subscriptions, and rolling back a SQL transaction cannot undo
external effects. All callbacks use Promises; the framework runs Effect internally.

Do not include an app ID or credentials in browser code. The host binds both
identity and authentication. Compiled imports and `ui/public/` files are retained
with the version. Import images and fonts from scripts or CSS. In `ui/index.html`,
reference files with relative URLs. From script code, request `ui/public/` files
by absolute path, such as `fetch("/data.json")`. The page has no `<base>`, so
links, `#` fragments and history URLs resolve against the page itself. Each
activation automatically reloads open pages. SSR, React Server Components and
public sharing are not part of this version.

`ui/index.html` is the app's main page. Build further screens as React routes:
any path without a dot serves that page. App responses send
`Content-Security-Policy: frame-ancestors 'none'`, so no page can be framed,
not even in an `<iframe>` on the app's own origin.

`ui/public/` files are served at the page's origin exactly as they are, with
their content types: scripts, styles, JSON, web manifests, images, fonts, audio,
video, `.wasm` (`application/wasm`), `.glb` models and `.html` pages among
them. Unknown extensions are `application/octet-stream`. They may be binary.
`ui/index.html` may load a prebuilt script or stylesheet from `ui/public/`
directly, such as `<script type="module" src="/assets/index.js">`; it is
served as it is, not compiled. A compiled file may not take the path of a
public file. Public files support byte ranges and revalidate against their
content, so media seeks and unchanged files are cheap. Each version serves
its own files; activating an older version serves its files again.

## Desktop app

People can install an app with a UI as its own app in the Executor desktop app,
from the app's page in the desktop's dashboard, for local and hosted servers.
It opens `ui/index.html` in its own window. The files and calls below take
effect only when the app is installed there; in a browser tab they change
nothing.

`ui/icon.svg` is the app's icon for its window, launcher and menu bar. It must be
one well-formed XML `<svg xmlns="http://www.w3.org/2000/svg">` element of at most
64 KiB, with no DOCTYPE, `<script>`, `<foreignObject>`, `on*` event attribute or
link outside the icon (an `href` or `xlink:href` other than `#id`), or the deploy
fails. The app's origin serves it at `/_executor/icon.svg`.

`ui/menubar.html` adds a menu-bar page, which the desktop shows in a popover from
the app's menu-bar icon. It is its own small entry, built like `ui/index.html`
with its own module script such as `ui/menubar.tsx`. Share code with the main
page by importing the same modules; keep the entry small, since it opens on every
click. The app's origin serves it at `/_executor/menubar` after the usual
sign-in. To size the popover, add
`<meta name="executor:menubar" content="width=320, height=360">` to its `<head>`.
Executor draws nothing inside the popover.

`desktop` from `apps/client` reaches the desktop app:

```tsx
import { desktop, DesktopPermissionDenied, ShortcutTaken } from "apps/client";
import { useDesktopShortcut } from "apps/react";

export function SearchShortcut({ onOpen }: { onOpen: () => void }) {
  const failure = useDesktopShortcut("CommandOrControl+Shift+K", onOpen);
  if (failure instanceof ShortcutTaken) return <p>Another app uses {failure.accelerator}.</p>;
  if (failure instanceof DesktopPermissionDenied) return <p>Shortcuts are off for this app.</p>;
  return null;
}

export async function showUnread(count: number) {
  if (!desktop.available) return;
  try {
    await desktop.menuBar.setTitle(`${count} unread`);
    await desktop.window.setFloating(count > 0);
  } catch (error) {
    if (!(error instanceof DesktopPermissionDenied)) throw error;
  }
}
```

A window a global shortcut summons, which hides when the person clicks away:

```tsx
import { desktop } from "apps/client";
import { useDesktopShortcut, useDesktopWindowEvent } from "apps/react";

export function Summon() {
  useDesktopShortcut("CommandOrControl+Shift+Space", () => void desktop.window.toggle());
  useDesktopWindowEvent("blur", () => void desktop.window.hide());
  return null;
}
```

Call hooks such as `useDesktopShortcut` only inside a component. Guard
imperative calls with `desktop.available` in code that also runs in a browser
tab, and expect `DesktopPermissionDenied` whenever the person declines.

- `desktop.available` is `true` only in an installed app window or its menu-bar
  popover.
- `desktop.permission(name)` resolves `"granted"`, `"denied"`, `"prompt"` or
  `"unavailable"` without asking. `desktop.requestPermission(name)` asks now if
  the person has not answered and resolves their choice; use it for
  `"startAtLogin"`, which nothing else asks for. Names: `"menuBar"`,
  `"shortcuts"`, `"floating"`, `"startAtLogin"`, `"microphone"`, `"camera"`,
  `"systemAudio"`, `"clipboardRead"`, `"notifications"` (`desktopPermissions`).
  `useDesktopPermission(name)` from `apps/react` reads one and reads it again
  whenever the window gains focus.
- `desktop.menuBar.setTitle(text)` shows plain text of at most 24 characters
  (`desktopMenuBarTitleMaxLength`) in the menu bar; `null` restores the app's
  name.
- `desktop.shortcuts.register(accelerator, handler)` holds a global shortcut in
  Electron accelerator syntax and resolves a function that removes it. The
  shortcut stays held until that function resolves; if it rejects, call it
  again.
  `useDesktopShortcut(accelerator, handler)` from `apps/react` holds one while
  the component is mounted, does nothing outside the desktop, and returns why
  registering failed, or `undefined`.
- `desktop.window.show()`, `hide()`, `focus()` and `toggle()` act on the window
  the page is in. `focus()` shows it and brings it in front of other apps, as a
  shortcut that summons the app needs; `toggle()` hides a visible, focused
  window and focuses it otherwise. A hidden window's page keeps running.
- `desktop.window.onBlur(handler)` and `onFocus(handler)` return a function
  that stops listening; `useDesktopWindowEvent("blur", handler)` from
  `apps/react` does the same while mounted. Hide a summoned window when the
  person clicks away with
  `useDesktopWindowEvent("blur", () => void desktop.window.hide())`.
- `desktop.window.open(path, { width?, height?, floating? })` opens another
  window of the app at a path on its own origin, such as `"/compose?to=ada"`,
  or focuses the one already showing that path. It has `desktop` too, with the
  same permissions, and closes when the app quits. An app has at most 8 others
  open (`desktopMaximumWindows`); `floating` needs the `floating` permission.
- `desktop.window.setFloating(on)` keeps the app's window above other windows.
- `desktop.badge.set(count)` shows a whole number up to 99999 on the app's
  icon; `null` or 0 removes it, and `useDesktopBadge(count)` from `apps/react`
  shows it while mounted. On Windows the count is on the app's own taskbar
  button. On macOS and Linux installed apps share Executor's Dock or launcher
  icon, which shows the sum of every app's count. It needs no permission.
- `desktop.audio.system()` resolves an audio-only `MediaStream` of everything
  playing on the computer, such as the other people in a call, after the
  `systemAudio` permission. Stop its tracks when done. It works on Windows and
  macOS 13 or later; elsewhere `systemAudio` is `"unavailable"` and the call
  rejects with `DesktopUnavailable`. On macOS it rejects with
  `SystemAudioBlocked` until the person turns Executor on in System Settings ›
  Privacy & Security › Screen & System Audio Recording; the desktop has already
  offered to open that page.

Each capability is off until the app first uses it. The desktop then asks the
person once and keeps the answer for the app, across versions, until they change
it in the tray menu, the app window's menu or the Desktop section of the app's
Settings page. Failures reject with classes to check with `instanceof`:
`DesktopUnavailable` outside an installed window, `DesktopPermissionDenied` when
the person declined, `ShortcutTaken` when another program holds the keys,
`DesktopInvalidInput` for input such as a title that is too long, and
`SystemAudioBlocked` as above. Outside the desktop `permission` and
`requestPermission` resolve `"unavailable"` and every other call rejects with
`DesktopUnavailable`, so check `desktop.available` in code that also runs in a
browser tab.

Standard web APIs need the matching permission in the desktop and behave as in
a browser tab elsewhere:

- `navigator.mediaDevices.getUserMedia({ audio: true })` needs `microphone`,
  and `{ video: true }` needs `camera`. On macOS the system asks once more, for
  Executor. Revoking either reloads the app's windows, which ends any recording.
- `navigator.clipboard.readText()` needs `clipboardRead`; writing needs nothing.
- `new Notification(title, { body, data: { path } })` needs `notifications`.
  When the person clicks it, the desktop focuses the app's window and, with
  `data.path`, opens that path on the app's origin.
- `<a download>` and blob downloads ask where to save, starting in Downloads,
  as a browser does. `showSaveFilePicker()` needs no permission.

`startAtLogin` opens the app without a window each time the person logs in, so
it can hold shortcuts or a menu-bar item. A link
`executor://app/<server>/<app>/<path>?<query>` opens the installed app at that
path.

## Hook result

`useAppQuery(atom)` returns `{ data, pending, error }`, never the query data directly.
`data` is `undefined` until a successful result. `pending` means no result has arrived.
`error` is an optional safe message. Keep an existing result visible during a failed refresh.

```tsx
const { data, pending, error } = useAppQuery(todosAtom);
const todos = data ?? [];
```

Use `framework.describe` for `apps/react.useAppQuery`, `AppClient.queryAtom`, and
`AppClient.mutate` before using an unfamiliar call shape. Type parameters on
`queryReference` and `mutationReference` describe the individual operation,
for example `queryReference<typeof list>("list")`, not the entire app.

## Optimistic mutations

Use the Convex-style `withOptimisticUpdate` helper on a callable mutation:

```tsx
const listRef = queryReference<typeof list>("list");
const todos = client.queryAtom(listRef, {}, array(Todo));
const setDone = client
  .mutation(mutationReference<typeof setTodoDone>("setTodoDone"), Todo)
  .withOptimisticUpdate((store, input) => {
    const rows = store.getQuery(listRef, {});
    if (rows !== undefined) {
      store.setQuery(
        listRef,
        {},
        rows.map((row) => (row.id === input.id ? { ...row, done: input.done } : row)),
      );
    }
  });
await setDone({ id, done: true });
```

`getQuery` reads the projected value, or `undefined` when the query is not loaded.
`getAllQueries(reference)` returns `{ input, value }` for every mounted argument
variant. Update filtered lists deliberately. `setQuery` replaces a mounted value
and validates it with that query's output schema. It does not create a subscription.
The complete `live-inbox` example returned by `framework.describe` shows insertion
with a temporary ID. Create IDs before calling the mutation, and pass them as input.

A temporary ID is only a UI placeholder. The example's server ignores `clientId`
and returns a row with a database-generated ID; the client does not rewrite IDs
in later mutation arguments. If you add per-row actions, use distinguishable
temporary IDs (for example, `"pending:" + crypto.randomUUID()`) and disable edit,
toggle and delete for those rows. Enable them when reconciliation replaces the
placeholder with the authoritative row. Awaiting the create Promise alone is
not sufficient: it resolves before the placeholder is necessarily replaced.
Do not send a temporary ID to a database mutation or assume queued writes map it.

The callback must be synchronous, pure, and return nothing. It can run repeatedly
over newer server data. Do not mutate values, make network calls, or generate IDs
inside it. A failed callback before execution prevents that write. A callback that
fails on a later replay loses its projection and reports a browser error; it does
not change the outcome of a write already sent.

Use one client per page and create stable query atoms outside components or with
`useMemo`. Components using the same client, operation and input share a cache.
One-shot `client.query` calls do not populate it. Dispose the client when its owner
is removed; page navigation disposes it automatically.

All invocations project immediately in call order. Writes from this client run
one at a time. The framework pauses old subscriptions, sends a write once, and
reads mounted queries again before sending the next write. Each reconciliation
read has a 30-second timeout; reads for unmounted queries are cancelled. Pending
projections replay over those fresh results. A rejected write removes only its
own projection. No component rollback snapshots or manual invalidation are needed.

The mutation Promise resolves when the server acknowledges the write. Its
projection remains until reconciliation finishes. A read failure appears in the
query's `error`, with its last authoritative value, and releases the queue.
Subscriptions then resume and can recover. A lost write response can leave the
outcome uncertain; the client reconciles but never retries the write automatically.
Other clients remain independent. This API does not provide offline writes or
atomic visibility across separate clients or different queries.

The client requests the browser's leave-page warning while any mutation is
queued or waiting for its response. It removes the warning once those Promises
settle, even if query reconciliation continues. The queue lives in the page:
choosing to leave, force-closing the browser, or a browser that suppresses the
warning can still discard unsent writes. Optimistic UI is not proof of a saved
write, and this warning does not provide durable background delivery.

Describe `AppClient.mutation`, `AppMutation.withOptimisticUpdate`, and
`OptimisticLocalStore.getAllQueries` for their generated signatures.
