// `virtual:executor-mcp-apps-shell-html` is supplied by `mcpAppsShellAsset`
// (`@executor-js/mcp-apps-shell/vite`). Referenced explicitly — and first, as
// triple-slash directives are only honored above the imports — so the ambient
// declaration travels with this file into consumers that bundle it; a
// consumer's tsconfig `include` covers only its own sources.
/// <reference path="./shell-html-url.d.ts" />
import { useCallback, useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ArtifactRendererProps } from "@executor-js/react/api/artifact-renderer";

import shellHtmlUrl from "virtual:executor-mcp-apps-shell-html";
// From `./preview-capture`, NOT from `./shell-app`: that module imports the
// shell build's virtual modules (`virtual:executor-tailwind-browser` and
// friends), which do not exist in the console's bundle — importing a constant
// from it drags them in and the artifact renderer fails to load entirely.
import { PREVIEW_CAPTURE_HOST_CONTEXT_KEY, SAVE_ARTIFACT_PREVIEW_TOOL } from "./preview-capture";
// Same reasoning as `./preview-capture`: a module with no build-graph imports of
// its own, so both the host half (here) and the app half (`shell-app.tsx`) can
// agree on the vocabulary without either dragging in the other's virtual
// modules.
import { FILL_DISPLAY_MODE, INLINE_DISPLAY_MODE } from "./display-mode";

/**
 * Hosts the MCP-Apps shell on the console's artifact page.
 *
 * The shell is NOT a React component this page mounts. It is a self-contained
 * DOCUMENT — the very bytes served as the `ui://executor/shell.html` resource —
 * loaded into a sandboxed iframe, with this component implementing the HOST half
 * of the MCP Apps protocol against it. The artifact page is therefore an MCP
 * Apps client like any other, and the shell runs in one configuration
 * everywhere.
 *
 * That is not architectural purity for its own sake; mounting `McpAppsShell`
 * inline was actively broken:
 *
 *   - It imports `@tailwindcss/browser` and its own `globals.css` at IMPORT
 *     scope, and it themes by toggling `document.documentElement`. Inline, all
 *     of that landed on the CONSOLE document — the shell's palette (a teal
 *     `--primary`) overwrote the console's strictly-grayscale tokens for the
 *     rest of the session, and its runtime Tailwind JIT kept mutating the page.
 *   - Its inner renderer reports content height over the MCP-Apps resize
 *     protocol, which expects a host frame to consume it. With no host, nothing
 *     did, so tall artifacts clipped mid-viewport.
 *
 * Both symptoms are one root cause — a document-scoped program mounted without
 * its document — and both are fixed by giving it one.
 *
 * This module is still BROWSER-ONLY (it builds a postMessage bridge against a
 * live iframe), so the `ArtifactRendererProvider` loader seam is unchanged: apps
 * register it through a dynamic `import()` that only ever resolves in the
 * browser, and the page holds it behind `ClientOnly` + `Suspense`. It stays the
 * DEFAULT export because the seam hands the loader straight to `React.lazy`.
 */

/** What the page passes as `host` — see `createHttpShellHost` in
 *  `@executor-js/react/api/shell-host`. Declared structurally because that
 *  package depends on THIS one for its component barrel, so importing its type
 *  here would close a package cycle turbo rejects outright. */
type HttpShellHost = {
  readonly callServerTool: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<CallToolResult>;
  readonly getHostContext: () => { readonly theme: "light" | "dark" } | undefined;
  readonly openLink: (params: { url: string }) => Promise<unknown>;
  /** Store a settled-render snapshot as this artifact's gallery preview. */
  readonly savePreview: (artifactId: string, preview: string) => void;
};

/** The frame height before the app has reported its content size, in the inline
 *  fallback path. Tall enough that the shell's own loading state is not itself
 *  clipped. */
const INITIAL_FRAME_HEIGHT = 320;

/**
 * A floor under the measured viewport.
 *
 * The container is measured, not guessed, so this only guards the degenerate
 * readings — a container measured while the page is still laying out, or a
 * window dragged to a sliver. Below this there is no room for a header and a
 * scroll region both, and a frame of a few pixels reads as a broken page.
 */
const MIN_FRAME_HEIGHT = 160;

/**
 * The console's active theme, resolved the way the console's own CSS resolves
 * it: an explicit `.dark` class wins, otherwise the OS preference.
 */
const readDocumentTheme = (): "light" | "dark" => {
  if (document.documentElement.classList.contains("dark")) return "dark";
  return globalThis.window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

/**
 * What this host tells the app about the surface it has.
 *
 * The detail page is the one place an artifact is not embedded in a flow of
 * other content — it IS the page — so it advertises the spec's `fullscreen`
 * mode and hands over a FIXED `containerDimensions.height`. Together those two
 * fields are the whole negotiation: the mode says "you own this surface", the
 * fixed height says how much of it there is. See `./display-mode` for why
 * `fullscreen` rather than a mode of our own, and why a fixed `height` rather
 * than a `maxHeight`.
 *
 * `availableDisplayModes` lists both, truthfully: this host can render an
 * artifact either way, and an app that asks to go back to `inline` is asking
 * for something the page could honor.
 *
 * Before the container has been measured (`viewport === null`) the page has not
 * yet laid out, and claiming a surface whose size is unknown would have the app
 * resolve `height: 100%` against nothing. So until then this is an ordinary
 * inline host, which is also what makes the mode switch a no-op for a viewport
 * that never resolves.
 */
const hostContextFor = (theme: "light" | "dark", viewport: number | null): McpUiHostContext => ({
  theme,
  displayMode: viewport === null ? INLINE_DISPLAY_MODE : FILL_DISPLAY_MODE,
  availableDisplayModes: [INLINE_DISPLAY_MODE, FILL_DISPLAY_MODE],
  platform: "web",
  ...(viewport === null ? {} : { containerDimensions: { height: viewport } }),
  // The console is the one host with somewhere to put a preview, so it is the
  // one host that asks for one. Carried on the spec's open index signature,
  // which is what it exists for; every other host omits it and the shell
  // skips the capture entirely.
  [PREVIEW_CAPTURE_HOST_CONTEXT_KEY]: true,
});

export default function ArtifactShell(props: ArtifactRendererProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  /**
   * The measured height of the page's content area, or `null` before the first
   * measurement.
   *
   * This — not the app's reported content height — is the frame's height. That
   * inversion is the fix: the artifact page gives the artifact a viewport and
   * holds it there, so the artifact's own `flex-1 min-h-0 overflow-auto` has
   * something to resolve against and its header can stay put while its table
   * scrolls underneath.
   */
  const [viewport, setViewport] = useState<number | null>(null);
  /**
   * The app's own reported content height — the inline story, kept for the case
   * where the container never resolves to a usable size (a host embedding this
   * component somewhere with no bounded height of its own). On the detail page
   * the observer resolves immediately and this is never read.
   */
  const [contentHeight, setContentHeight] = useState(INITIAL_FRAME_HEIGHT);
  const [theme, setTheme] = useState<"light" | "dark">(() => readDocumentTheme());

  // Read through refs inside the bridge: the bridge is built once per artifact,
  // and rebuilding it when the host identity changes would reload the iframe and
  // discard the rendered component.
  const hostRef = useRef(props.host as HttpShellHost);
  hostRef.current = props.host as HttpShellHost;
  const codeRef = useRef(props.code);
  codeRef.current = props.code;
  const artifactIdRef = useRef(props.artifactId);
  artifactIdRef.current = props.artifactId;
  // The bridge is built once per artifact and must see the CURRENT viewport,
  // both when it opens (so its initial host context is already the fill one)
  // and inside `onsizechange` (so it knows to ignore the report).
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const bridgeRef = useRef<AppBridge | null>(null);

  // Track the console's theme and forward it as host context, which is what
  // drives the shell's own `applyTheme` — inside the iframe's document, where it
  // belongs, rather than on the console's `documentElement`.
  useEffect(() => {
    const media = globalThis.window.matchMedia?.("(prefers-color-scheme: dark)");
    const sync = () => setTheme(readDocumentTheme());
    media?.addEventListener("change", sync);
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      media?.removeEventListener("change", sync);
      observer.disconnect();
    };
  }, []);

  /**
   * Measure the surface the page has given this artifact, and keep measuring.
   *
   * A `ResizeObserver` on the container rather than a `window` resize listener:
   * the content area is a flex child of the console's own layout, so it changes
   * height for reasons that never touch the window — the sidebar collapsing, a
   * banner appearing above it. Observing the box that actually holds the frame
   * catches all of those and the window resize alike.
   *
   * `borderBoxSize` is read in preference to `contentRect` so a container that
   * ever gains padding or a border still reports the space the frame occupies.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = (next: number) => {
      const bounded = Math.max(MIN_FRAME_HEIGHT, Math.floor(next));
      // Guard the state write, not just the render: an observer that fires on
      // every sub-pixel reflow would otherwise push a new host context — and
      // therefore a `ui/notifications/host-context-changed` — into the frame
      // continuously while a user drags a window edge.
      setViewport((prev) => (prev === bounded ? prev : bounded));
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const borderBox = entry.borderBoxSize?.[0]?.blockSize;
      measure(typeof borderBox === "number" ? borderBox : entry.contentRect.height);
    });
    observer.observe(container);
    // Seed from the current layout rather than waiting for the observer's first
    // callback, so the very first host context the bridge is built with already
    // carries a viewport and the app never renders a frame in the wrong mode.
    measure(container.getBoundingClientRect().height);

    return () => observer.disconnect();
  }, []);

  // Both the theme and the viewport travel on the same context, and
  // `setHostContext` diffs for us — it notifies the app only about fields that
  // actually changed, so a resize does not re-announce the theme.
  useEffect(() => {
    bridgeRef.current?.setHostContext(hostContextFor(theme, viewport));
  }, [theme, viewport]);

  /**
   * Build and connect the bridge the moment the iframe ELEMENT mounts — as the
   * frame's `ref`, not its `onLoad`.
   *
   * This ordering is the whole correctness argument, so it is worth stating
   * exactly. `ui/initialize` is a fire-and-forget `postMessage`: the app's
   * `connect()` sends it once, ext-apps has no retry, no backoff and no
   * readiness handshake, and `AppBridge` buffers nothing. The host's transport
   * only begins listening inside `bridge.connect()`, whose last synchronous step
   * is `window.addEventListener("message", …)`. So a `ui/initialize` posted
   * while the host has no listener is delivered to a window that ignores it and
   * is gone for good — both sides then wait forever, which is the shell stuck on
   * "Connecting" (the app's request does eventually time out after the SDK's 60s
   * default, but the host has long since stopped being able to answer).
   *
   * Connecting in `onLoad` lost that race. The frame's `load` event fires AFTER
   * its document has been parsed and its module scripts have run, so the app
   * could — and on a cold, dev-served, 4.5MB document did — post `ui/initialize`
   * before the host was listening. It "worked" locally only because the two
   * landed within a few milliseconds of each other.
   *
   * A ref callback runs during the commit phase, synchronously after React has
   * inserted the element into the document and therefore before the browser has
   * fetched a single byte of `src`. `contentWindow` is already non-null there
   * (it is the initial `about:blank` window), and a same-origin navigation keeps
   * the browsing context's WindowProxy identity — so both the transport's
   * `postMessage` target and its `event.source` filter still refer to the shell
   * document once it replaces the placeholder. The listener is thus provably up
   * before any script in the frame can run, whatever the machine, cache state or
   * document size. This is also how sunpeak's host does it, which is why real
   * MCP-Apps hosts never saw this bug.
   *
   * The returned cleanup makes this callback the SOLE owner of the bridge's
   * lifecycle. Previously an effect keyed on `props.code` closed
   * `bridgeRef.current`, which is a second, unsynchronized owner: under a
   * StrictMode double-invoke or any re-render that reorders effects against
   * refs, that cleanup could close a bridge a later mount had just connected,
   * stranding the shell on "Connecting" for an entirely different reason. Now
   * each bridge is created and closed by the same attach/detach pair and can
   * only ever close itself.
   */
  const attachFrame = useCallback((frame: HTMLIFrameElement | null): (() => void) | undefined => {
    frameRef.current = frame;
    const contentWindow = frame?.contentWindow;
    if (!contentWindow) return undefined;

    const bridge = new AppBridge(
      // No MCP client: the artifact page reaches the server over the ordinary
      // executions HTTP API, so every app-originated call is answered by the
      // handlers below rather than proxied onto an MCP connection.
      null,
      { name: "Executor Console", version: "1.0.0" },
      { openLinks: {}, serverTools: {} },
      { hostContext: hostContextFor(readDocumentTheme(), viewportRef.current) },
    );

    // Deliver the stored source the way a real host does after `create-artifact`: the
    // tool input, then the tool result carrying `structuredContent.code` — the
    // exact shape `renderedInAppResult` builds in the MCP host. The shell
    // already handles both, so it takes the same path here as it does under any
    // other MCP-Apps client, with no artifact-page-only branch.
    bridge.oninitialized = () => {
      const code = codeRef.current;
      const artifactId = artifactIdRef.current;
      void bridge
        .sendToolInput({ arguments: { code, artifactId } })
        .then(() =>
          bridge.sendToolResult({
            content: [{ type: "text", text: "Rendered saved artifact." }],
            structuredContent: { code, artifactId },
          }),
        )
        .catch((error: unknown) => {
          console.error("[executor-console] Failed to deliver the artifact to the shell:", error);
        });
    };

    /**
     * The app keeps reporting its content height. In fill mode this host
     * deliberately does nothing with it.
     *
     * That is the clean division the mode buys: the HOST owns the mode, so the
     * app does not need a branch for "am I being measured" — it reports its size
     * truthfully in every mode, exactly as the protocol says, and a host that
     * has already decided the frame's height simply does not consume the report.
     * Acting on it here would undo the whole fix, since the app's content is now
     * as tall as the viewport it was given and growing the frame to match would
     * chase itself.
     *
     * Inline hosts — every chat client — are untouched: the frame grows, the
     * page scrolls, nothing clips.
     */
    bridge.onsizechange = (params) => {
      if (viewportRef.current !== null) return;
      if (typeof params.height !== "number") return;
      setContentHeight(Math.max(MIN_FRAME_HEIGHT, Math.ceil(params.height)));
    };

    bridge.oncalltool = (params) => {
      // The shell's preview upgrade is not a server tool; it is this host's own
      // call, answered here. Intercepted before the tool transport so it never
      // reaches `/executions` — a snapshot is not an execution and must not be
      // metered, approved or logged as one.
      if (params.name === SAVE_ARTIFACT_PREVIEW_TOOL) {
        const artifactId = params.arguments?.["artifactId"];
        const preview = params.arguments?.["preview"];
        if (typeof artifactId === "string" && typeof preview === "string") {
          hostRef.current.savePreview(artifactId, preview);
        }
        return Promise.resolve({ content: [] } satisfies CallToolResult);
      }
      return hostRef.current.callServerTool({
        name: params.name,
        ...(params.arguments ? { arguments: params.arguments } : {}),
      });
    };

    bridge.onopenlink = async (params) => {
      await hostRef.current.openLink({ url: params.url });
      return {};
    };

    void bridge
      .connect(new PostMessageTransport(contentWindow, contentWindow))
      .catch((error: unknown) => {
        console.error("[executor-console] Artifact shell failed to connect:", error);
      });

    bridgeRef.current = bridge;

    // Detach: close THIS bridge, and only clear the shared ref if it is still
    // the current one, so a bridge that has already been replaced can never
    // null out its successor.
    return () => {
      void bridge.close();
      if (bridgeRef.current === bridge) bridgeRef.current = null;
      if (frameRef.current === frame) frameRef.current = null;
    };
  }, []);

  return (
    // The measured box. `h-full` against the page's content area is what makes
    // the measurement meaningful: the container is exactly the room the page has
    // given the artifact, so the number the observer reads is the number the
    // frame should be. `min-h-0` lets it shrink inside the page's flex column
    // rather than being floored at its content's height.
    <div
      ref={containerRef}
      data-testid="artifact-shell-container"
      className="h-full min-h-0 w-full"
    >
      <iframe
        // Keyed on the source: opening a different artifact remounts the
        // element, which detaches the old bridge and attaches a fresh one to a
        // fresh document rather than reusing a shell that has already rendered
        // something else.
        key={props.code}
        ref={attachFrame}
        data-testid="artifact-shell-frame"
        title="Artifact"
        src={shellHtmlUrl}
        // The shell document is our own build, but it runs model-written JSX in
        // a further nested frame of its own. Scripts and same-origin are what it
        // needs to boot React and reach that inner frame; popups let `openLink`
        // escape the sandbox rather than silently failing. Deliberately absent:
        // `allow-top-navigation` (nothing in the shell navigates the console)
        // and `allow-forms` (nothing posts one).
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        // Fill mode: the frame is exactly the measured viewport, and stays there
        // however tall the artifact's content becomes. Inline fallback: the
        // frame is the app's reported content height and the page scrolls.
        style={{ height: viewport ?? contentHeight }}
        className="block w-full border-0 bg-background"
      />
    </div>
  );
}
