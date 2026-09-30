# @executor-js/react

## 1.4.74

### Patch Changes

- [#2062](https://github.com/UsefulSoftwareCo/executor/pull/2062) [`29413d8`](https://github.com/UsefulSoftwareCo/executor/commit/29413d8dafaeabfd9b9f10e5fddd1f5b735ffa30) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Tool policies set from an account section of the integration Tools tab now apply to that connection only, and each account header gets a menu to set a policy for the whole connection. Members no longer see policy controls they cannot use, and a refused policy write shows the server's reason.

- [#2051](https://github.com/UsefulSoftwareCo/executor/pull/2051) [`31b24b8`](https://github.com/UsefulSoftwareCo/executor/commit/31b24b8564899b137106baf28f66fb3f15c33633) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Show restricted integration actions as disabled controls with an admin explanation. Members can browse the catalog and add personal connections to existing integrations.

- Updated dependencies [[`2e5aa16`](https://github.com/UsefulSoftwareCo/executor/commit/2e5aa16bedb4ba74448b3f9338754764b40519a0), [`4a08d8d`](https://github.com/UsefulSoftwareCo/executor/commit/4a08d8db6f74612e07f17494e222ff038d8af944)]:
  - @executor-js/sdk@1.6.11
  - @executor-js/api@1.4.74

## 1.4.73

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.10
  - @executor-js/api@1.4.73

## 1.4.72

### Patch Changes

- [#1976](https://github.com/UsefulSoftwareCo/executor/pull/1976) [`40b2f2e`](https://github.com/UsefulSoftwareCo/executor/commit/40b2f2e38d642843eb7c984c020117e0db52acfc) Thanks [@SunkenInTime](https://github.com/SunkenInTime)! - Carry an approval's persistence choice through elicitation, so Codex Computer Use stops asking to use the same app on every call.

  Computer Use offers `persist: ["session", "always"]` in the prompt's terms and remembers the app only when the answer names one. Executor dropped the offer on the way in (the terms projection kept strings only) and the choice on the way out (every adapter rebuilt the reply from `action` and `content`), so each accept was one-time. `ElicitationResponse` now has `meta.persist`; the MCP plugin, the app-server bridge, and the MCP host pass it through; the model-mode `resume` tool and the browser approval page let the approver pick from the offered scopes. Nothing is chosen automatically: a bare accept still approves once.

- [#2025](https://github.com/UsefulSoftwareCo/executor/pull/2025) [`be77521`](https://github.com/UsefulSoftwareCo/executor/commit/be775216cccddac6002b1f9442b3c8151e4f6063) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Member lists, the admin users page, and seat counts on cloud now read from the local membership mirror through the shared `MemberDirectory` seam instead of fanning out one WorkOS read per member. The admin users page gains an email/name search.

  **Deploy prerequisite (cloud):** `bun run --cwd apps/cloud db:backfill-workos-mirror:prod` must complete before this build is deployed, and its printed membership count should match WorkOS. Until the backfill has stamped the mirror's marker, seat reporting to Autumn is skipped with a warning (never a partial count) and member lists show only members who have signed in since the mirror shipped.

- [#1952](https://github.com/UsefulSoftwareCo/executor/pull/1952) [`1f67d83`](https://github.com/UsefulSoftwareCo/executor/commit/1f67d83609b13a73d3dc8d630f48c8f54a02e6ca) Thanks [@Karavil](https://github.com/Karavil)! - Support POST health checks for APIs that expose reads through HTTP RPC. Warn that POST can change data, allow validated JSON request bodies, and display the reason when a configured probe cannot run.

- [#1892](https://github.com/UsefulSoftwareCo/executor/pull/1892) [`905e097`](https://github.com/UsefulSoftwareCo/executor/commit/905e0972614aed5a3bb279b51dc060f87f892d75) Thanks [@ra-co88](https://github.com/ra-co88)! - fix: honor prefers-reduced-motion in the shared stylesheet

  Adds a `prefers-reduced-motion: reduce` block to the global stylesheet that
  caps transition/animation durations to 0.01ms and disables smooth scrolling,
  so motion-sensitive users get a stable UI. The loading spinner renders
  statically under reduced motion (its meaning is preserved via `role="status"`).

- Updated dependencies [[`d873caf`](https://github.com/UsefulSoftwareCo/executor/commit/d873caf6fb3aa7408270b42aaad77f53cf9ec090), [`40b2f2e`](https://github.com/UsefulSoftwareCo/executor/commit/40b2f2e38d642843eb7c984c020117e0db52acfc), [`65d939e`](https://github.com/UsefulSoftwareCo/executor/commit/65d939ebab6f77a00a3435fe3575399cd1cd3b7f), [`3c263d7`](https://github.com/UsefulSoftwareCo/executor/commit/3c263d7580d1d9302a1dc5d63f2fab253fd409c2), [`61f71c5`](https://github.com/UsefulSoftwareCo/executor/commit/61f71c56fe799b6e0faa2b2f82a91f631bc6a979), [`a6cdcf1`](https://github.com/UsefulSoftwareCo/executor/commit/a6cdcf1ccfae22e7d3378908c095e5c847c70f90), [`be77521`](https://github.com/UsefulSoftwareCo/executor/commit/be775216cccddac6002b1f9442b3c8151e4f6063), [`f8cfa5f`](https://github.com/UsefulSoftwareCo/executor/commit/f8cfa5f5f475c6b9c14143663ed5861bec8f74af), [`cc0fd8f`](https://github.com/UsefulSoftwareCo/executor/commit/cc0fd8f6099f3d05c73a285ef14932c01ac212fa), [`85cf428`](https://github.com/UsefulSoftwareCo/executor/commit/85cf428905bbd73257fb3c3be5c89e762bf79377), [`38a7725`](https://github.com/UsefulSoftwareCo/executor/commit/38a7725876bcc9c8adeea9c7efbd190c121d3b86), [`3fd28a5`](https://github.com/UsefulSoftwareCo/executor/commit/3fd28a51fabb0fc96d0bf83408021e7cbca70bfe), [`929b233`](https://github.com/UsefulSoftwareCo/executor/commit/929b2338f225b3f80190ac7a6fe1f2473650c58c)]:
  - @executor-js/api@1.4.72
  - @executor-js/sdk@1.6.9

## 1.4.71

### Patch Changes

- Updated dependencies [[`31a8042`](https://github.com/UsefulSoftwareCo/executor/commit/31a8042450475fd86ea580f4dbd5dcc3c290c008), [`b5271a6`](https://github.com/UsefulSoftwareCo/executor/commit/b5271a6f0cb6d0c42a6b9fbcdffe70fc2aad8bc6), [`caa0391`](https://github.com/UsefulSoftwareCo/executor/commit/caa03919a8f2a5c82ed13bc4ea9060e964af3a79)]:
  - @executor-js/sdk@1.6.8
  - @executor-js/api@1.4.71

## 1.4.70

### Patch Changes

- Updated dependencies [[`98d6c6a`](https://github.com/UsefulSoftwareCo/executor/commit/98d6c6ad3272fca371fc2d8b14b2e332100d8322)]:
  - @executor-js/sdk@1.6.7
  - @executor-js/api@1.4.70

## 1.4.69

### Patch Changes

- [#1865](https://github.com/UsefulSoftwareCo/executor/pull/1865) [`9a1fbd5`](https://github.com/UsefulSoftwareCo/executor/commit/9a1fbd5f0de25f622f303c76f998443c1bb72063) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Desktop OAuth connects finish the moment the provider redirects**

  When the desktop app runs an OAuth flow in the system browser, the app learned about completion by polling the local server once a second. The completed result sat in memory while the user watched the "Connecting…" spinner for up to a second more — about half a second wasted on average, on every connect.

  The await endpoint now long-polls: the server holds the request open (up to 25 seconds per hold) and answers the instant the flow completes. The client polls one request at a time and reconnects after each answer, so requests never stack. Mixed versions stay compatible in both directions: an old client still gets its answer within one poll of a new server, and a new client against an old server behaves exactly as before.

- Updated dependencies []:
  - @executor-js/api@1.4.69
  - @executor-js/sdk@1.6.6

## 1.4.68

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.5
  - @executor-js/api@1.4.68

## 1.4.67

### Patch Changes

- [#1559](https://github.com/UsefulSoftwareCo/executor/pull/1559) [`9dcfaa5`](https://github.com/UsefulSoftwareCo/executor/commit/9dcfaa5ee8ad2ebc17407caf94d8d4dcf55e3562) Thanks [@Adityakk9031](https://github.com/Adityakk9031)! - **Reconnecting a DCR connection now re-registers instead of reusing a stranded client**

  A dynamically registered OAuth client is bound to the redirect URI it registered with. Once the app's callback origin changed (127.0.0.1 to localhost), Reconnect still started the flow against the stored client, and the authorization server rejected it — leaving no way to repair the connection.

  Reconnect now takes the same probe → CIMD-or-register → start route as the initial connect, so the registration gateway replaces the stranded client against the current redirect URI. Methods with a fixed, hand-registered app are unaffected and keep using their stored client.

- Updated dependencies [[`ffcfbc0`](https://github.com/UsefulSoftwareCo/executor/commit/ffcfbc0de27d0ae55215839fb70395b0b7d9a65c), [`10e16a5`](https://github.com/UsefulSoftwareCo/executor/commit/10e16a5baa2648657b70038e7d11429c58e4d242), [`515d6aa`](https://github.com/UsefulSoftwareCo/executor/commit/515d6aa391a04a3579a7b10f974ec316a563cf7a), [`06bf742`](https://github.com/UsefulSoftwareCo/executor/commit/06bf74254f3432e8d75fd8b493ef7a435ea4bc84)]:
  - @executor-js/sdk@1.6.4
  - @executor-js/api@1.4.67

## 1.4.66

### Patch Changes

- [#1814](https://github.com/UsefulSoftwareCo/executor/pull/1814) [`66fb1a4`](https://github.com/UsefulSoftwareCo/executor/commit/66fb1a4154226d28691ca83bdf6f3daa417ef0ce) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **A click outside a dialog or sheet no longer discards the form inside it**

  Radix dismisses an overlay surface on any un-prevented outside interaction, and `DialogContent` and `SheetContent` only prevented that for clicks landing in a portaled combobox or select popup. Every other outside click fell through to dismissal, so a stray click on the page behind a form — after switching windows to copy an ID, for example — closed the surface and destroyed what the user had typed. These surfaces unmount their state on close by design, so nothing was recoverable.

  The default is now the opposite: an outside interaction keeps the surface open. Escape and the close button are unchanged and still close it. `DialogContent` and `SheetContent` take a new `dismissOnOutsideClick` prop for surfaces with nothing to lose — confirmations, pickers, and read-only panels — and the portaled-popup guard still applies there, so choosing a combobox option never dismisses.

  `CommandDialog` sets `dismissOnOutsideClick` on by default, because a command palette holds only a search string and clicking away is the expected way to leave it.

- [#1822](https://github.com/UsefulSoftwareCo/executor/pull/1822) [`d7e4b73`](https://github.com/UsefulSoftwareCo/executor/commit/d7e4b73a86b8e413af70e0fcb26f38a35a3f4546) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **An OAuth app can now be registered without an RFC 8707 resource, and that absence holds on every request**

  Microsoft Entra v2 rejects any authorization request that carries both a v2 `scope` (such as `https://api.fabric.microsoft.com/.default`) and the RFC 8707 `resource` parameter, failing with `AADSTS9010010` before the consent screen. Executor made that unavoidable for MCP servers behind Entra: registering an app for an MCP integration always derived the MCP endpoint as the resource, the form had no field to change it, and so every request carried the parameter Entra rejects.

  The register/edit OAuth app form now shows the resource indicator. It is still prefilled for MCP servers — nothing changes for providers that accept the parameter — but it can be cleared, and a cleared value persists as "no resource". A resource-less app then omits `resource` on all four grants alike: the authorization request, the code exchange, token refresh, and client-credentials. Symmetry matters here — sending `resource` on authorize but not on the token request (or the reverse) would bind the two tokens to different audiences.

  Two adjacent gaps closed with it:
  - MCP scope discovery no longer depends on the app's resource. It now falls back to the integration's own discovery URL (the MCP endpoint), so clearing the resource does not break connecting.
  - Token refresh for a first-party OAuth app dropped the app's configured resource, refreshing to a different audience than the original grant. It now sends the same resource the authorization request sent.

  Apps that keep their resource — the default for every discovered MCP server — behave exactly as before: the parameter is sent on every grant, as the MCP authorization spec expects.

- Updated dependencies [[`c1f51b7`](https://github.com/UsefulSoftwareCo/executor/commit/c1f51b7f96328b795669bb3d241667660dc2b060), [`02b52cd`](https://github.com/UsefulSoftwareCo/executor/commit/02b52cd01b09d3601ffe88d1f9c0b777f26e76ae)]:
  - @executor-js/sdk@1.6.3
  - @executor-js/api@1.4.66

## 1.4.65

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.2
  - @executor-js/api@1.4.65

## 1.4.64

### Patch Changes

- [#1746](https://github.com/UsefulSoftwareCo/executor/pull/1746) [`9dff4e8`](https://github.com/UsefulSoftwareCo/executor/commit/9dff4e8e6598e7d3108634a71269245ba9b480bb) Thanks [@sergical](https://github.com/sergical)! - **The connection edit sheet now previews what agents actually read**

  The "What agents see" preview in the connection edit sheet rendered a `- \`<prefix>\` — <description>`inventory line. That line left the`execute`tool description when the inventory was slimmed to bare integration slugs, so the preview showed text no agent reads. The account label was also marked "Display-only", but`connections.list` returns it to agents alongside the description.

  The preview now mirrors the `connections.list` item for the connection (`name`, `identityLabel`, `description`), and the sheet copy says that both fields are agent-visible while the callable name stays as it was at connect time.

- Updated dependencies [[`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72)]:
  - @executor-js/sdk@1.6.1
  - @executor-js/api@1.4.64

## 1.4.63

### Patch Changes

- [#1703](https://github.com/UsefulSoftwareCo/executor/pull/1703) [`2bdbedf`](https://github.com/UsefulSoftwareCo/executor/commit/2bdbedf257f54d7c209e8c856c618174c10d6bb3) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **A slow OAuth discovery no longer kills the connect with no popup and no error**

  The transparent connect flows opened the sign-in window only after their setup round trips had answered: DCR after probe and dynamic registration, CIMD after minting the client, reconnect after starting the session. `window.open` needs transient user activation, which browsers expire a few seconds after the click, so once the API was slow enough the browser refused the window and the connect ended with nothing on screen but the button returning to "Connect". Every MCP integration takes that path.

  The window is now claimed on the click itself and navigated when the authorization URL arrives, however long that takes, and it is closed again on the paths that end without signing in (failed probe, no registration endpoint, rejected registration, failed client mint) as well as on cancel and unmount. A window the browser does refuse is now reported instead of swallowed: the flows stop before their round trips, and the sign-in error renders above the dialog footer, where the automatic flows can actually show it, rather than inside a method tab panel they never render.

- Updated dependencies [[`a2d1417`](https://github.com/UsefulSoftwareCo/executor/commit/a2d141758e478274813c8c24d354e1fd0f66af49)]:
  - @executor-js/sdk@1.6.0
  - @executor-js/api@1.4.63

## 1.4.62

### Patch Changes

- Updated dependencies [[`d3f0617`](https://github.com/UsefulSoftwareCo/executor/commit/d3f0617deec06c57e0d6e1479fe668f79daf977d)]:
  - @executor-js/sdk@1.5.42
  - @executor-js/api@1.4.62

## 1.4.61

### Patch Changes

- Updated dependencies [[`d572658`](https://github.com/UsefulSoftwareCo/executor/commit/d572658d74097917412256f10a3ea2e3974f44dd)]:
  - @executor-js/sdk@1.5.41
  - @executor-js/api@1.4.61

## 1.4.60

### Patch Changes

- Updated dependencies [[`8ba64f6`](https://github.com/UsefulSoftwareCo/executor/commit/8ba64f675f6d6ab5302d4f68390c0b055d006f4a)]:
  - @executor-js/sdk@1.5.40
  - @executor-js/api@1.4.60

## 1.4.59

### Patch Changes

- Updated dependencies [[`6c316c7`](https://github.com/UsefulSoftwareCo/executor/commit/6c316c77a9efc98784976236852b58c6156e016e)]:
  - @executor-js/sdk@1.5.39
  - @executor-js/api@1.4.59

## 1.4.58

### Patch Changes

- [#1240](https://github.com/UsefulSoftwareCo/executor/pull/1240) [`1de85fc`](https://github.com/UsefulSoftwareCo/executor/commit/1de85fc0201c0c23c0e71e003c49228d406af6c8) Thanks [@jackulau](https://github.com/jackulau)! - Keep native `<select>` dropdown options readable in dark mode. The console themes through `prefers-color-scheme` and never sets a `.dark` class, so Tailwind `dark:` utilities never matched and the native option popup rendered with a light color scheme over dark text. `NativeSelect` now uses a solid themed surface (`bg-popover`) and pins `color-scheme` to the active theme, so the browser draws a matching, readable popup.

- Updated dependencies [[`6a924dd`](https://github.com/UsefulSoftwareCo/executor/commit/6a924dd98de916d6ff8cea2329bf672f149b64f4)]:
  - @executor-js/sdk@1.5.38
  - @executor-js/api@1.4.58

## 1.4.57

### Patch Changes

- Updated dependencies [[`657b913`](https://github.com/UsefulSoftwareCo/executor/commit/657b9135b8b841495b362936bf60bdca998c16eb)]:
  - @executor-js/sdk@1.5.37
  - @executor-js/api@1.4.57

## 1.4.56

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.36
  - @executor-js/api@1.4.56

## 1.4.55

### Patch Changes

- Updated dependencies [[`1b9b1f1`](https://github.com/UsefulSoftwareCo/executor/commit/1b9b1f10313834a625a411169ebf83f6181589df)]:
  - @executor-js/sdk@1.5.35
  - @executor-js/api@1.4.55

## 1.4.54

### Patch Changes

- Updated dependencies [[`e2712db`](https://github.com/UsefulSoftwareCo/executor/commit/e2712dbff98145c5c340832ffbdcb21113b9dd78), [`7207347`](https://github.com/UsefulSoftwareCo/executor/commit/720734756a70b1b4f1564bdf82dc4118e5de2b76), [`0c4e9b4`](https://github.com/UsefulSoftwareCo/executor/commit/0c4e9b49fecb35ad71c92a464c3ea01131ff9d6f)]:
  - @executor-js/sdk@1.5.34
  - @executor-js/api@1.4.54

## 1.4.53

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.33
  - @executor-js/api@1.4.53

## 1.4.52

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.32
  - @executor-js/api@1.4.52

## 1.4.51

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.31
  - @executor-js/api@1.4.51

## 1.4.50

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.30
  - @executor-js/api@1.4.50

## 1.4.49

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.29
  - @executor-js/api@1.4.49

## 1.4.48

### Patch Changes

- Updated dependencies [[`1c48182`](https://github.com/UsefulSoftwareCo/executor/commit/1c4818254e71dc4ee27ff95f489e2c5cf330a450)]:
  - @executor-js/sdk@1.5.28
  - @executor-js/api@1.4.48

## 1.4.47

### Patch Changes

- Updated dependencies [[`c7ab1e2`](https://github.com/RhysSullivan/executor/commit/c7ab1e2d56884e0453af85f6399fd25a39f04785)]:
  - @executor-js/api@1.4.47
  - @executor-js/sdk@1.5.27

## 1.4.46

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.26
  - @executor-js/api@1.4.46

## 1.4.45

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.25
  - @executor-js/api@1.4.45

## 1.4.44

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.24
  - @executor-js/api@1.4.44

## 1.4.43

### Patch Changes

- [#1199](https://github.com/RhysSullivan/executor/pull/1199) [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Notify when a newer Executor is published. The CLI now prints an "update available" line under its ready banner, and the web shell's sidebar update card works for real (a new `/v1/app/npm/dist-tags` endpoint backs it). In the desktop app the card shows a native "Restart to update" action wired to the in-app updater instead of the npm command. The check is best-effort and offline-safe, and can be disabled with `EXECUTOR_DISABLE_UPDATE_CHECK`.

- Updated dependencies [[`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a), [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a)]:
  - @executor-js/api@1.4.43
  - @executor-js/sdk@1.5.23

## 1.4.42

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.22
  - @executor-js/api@1.4.42

## 1.4.41

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.21
  - @executor-js/api@1.4.41

## 1.4.40

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.20
  - @executor-js/api@1.4.40

## 1.4.39

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.19
  - @executor-js/api@1.4.39

## 1.4.38

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.18
  - @executor-js/api@1.4.38

## 1.4.37

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.17
  - @executor-js/api@1.4.37

## 1.4.36

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.16
  - @executor-js/api@1.4.36

## 1.4.35

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.15
  - @executor-js/api@1.4.35

## 1.4.34

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.14
  - @executor-js/api@1.4.34

## 1.4.33

### Patch Changes

- Updated dependencies []:
  - @executor-js/api@1.4.33
  - @executor-js/sdk@1.5.13

## 1.4.32

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.12
  - @executor-js/api@1.4.32

## 1.4.31

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.11
  - @executor-js/api@1.4.31

## 1.4.30

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.10
  - @executor-js/api@1.4.30

## 1.4.29

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.9
  - @executor-js/api@1.4.29

## 1.4.28

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.8
  - @executor-js/api@1.4.28

## 1.4.27

### Patch Changes

- Updated dependencies [[`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15), [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15)]:
  - @executor-js/sdk@1.5.7
  - @executor-js/api@1.4.27

## 1.4.26

### Patch Changes

- [#943](https://github.com/RhysSullivan/executor/pull/943) [`f485e4a`](https://github.com/RhysSullivan/executor/commit/f485e4a23cf3756b9e628cf2d9242fbc0b3da178) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **One auth model across OpenAPI, GraphQL, and MCP**
  - Every protocol plugin now stores the same placements-based auth methods (the new `@executor-js/sdk/http-auth` vocabulary): an API-key method carries any mix of header and query placements, each rendered from its own credential input — so one source can declare OAuth, a bearer-header-plus-team-id-query method, a plain bearer, and a query token side by side, and one connection can carry several values (e.g. both Datadog keys).
  - MCP and GraphQL gain what only OpenAPI could do before: multi-placement methods, query-parameter credentials (servers like ui.sh's `?token=`), and multi-input connections. Rendering, catalog projection, slug normalization, and the React method editor/codec are shared instead of triplicated; the connect modal collects one value per input.
  - Invoking with an unresolvable credential input now fails with `connection_value_missing` (naming the missing inputs) instead of silently dialing unauthenticated.
  - Stored integration configs are rewritten to the canonical shape by a one-off migration: local and self-host run it automatically at startup; cloud operators run `bun run db:migrate-auth:prod` before deploying. Connection bindings and stored credential values are preserved exactly.
  - Authoring: apikey methods are authored in ONE request-shaped dialect on every plugin — it reads like the request it produces: `{ type: "apiKey", headers: { Authorization: ["Bearer ", variable("token")] }, queryParams: { team_id: [variable("team_id")] } }` (`variable()` is exported from each plugin; a plain-string value is a static literal). Inputs normalize to the canonical placements model, which is what stored configs and the catalog read as. Authoring is strict where the renderer is: a value carries at most one variable, as the final part.
  - Every method is keyed by `kind` — OpenAPI's oauth templates re-key from the retired `type: "oauth"` spelling to `kind: "oauth2"` (matching MCP/GraphQL); the one-off migration rewrites stored entries.
  - Breaking (wire): the retired single-placement inputs (`headerName` on MCP, `in`/`name` on GraphQL), raw canonical-placement inputs, and `type: "oauth"` oauth inputs are rejected. The `mcp.addServer` singular `auth` shorthand still works.

- Updated dependencies []:
  - @executor-js/sdk@1.5.4
  - @executor-js/api@1.4.26

## 1.4.25

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.3
  - @executor-js/api@1.4.25

## 1.4.24

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.2
  - @executor-js/api@1.4.24

## 1.4.23

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.1
  - @executor-js/api@1.4.23

## 1.4.22

### Patch Changes

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad)]:
  - @executor-js/sdk@1.5.0
  - @executor-js/api@1.4.22
