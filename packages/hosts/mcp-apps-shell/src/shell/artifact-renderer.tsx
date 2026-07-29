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
};

/** The frame height before the app has reported its content size. Tall enough
 *  that the shell's own loading state is not itself clipped. */
const INITIAL_FRAME_HEIGHT = 320;

/** A floor under the app's reported height, so a transient zero-height report
 *  (mid-render, or between artifacts) never collapses the frame. */
const MIN_FRAME_HEIGHT = 160;

/**
 * The console's active theme, resolved the way the console's own CSS resolves
 * it: an explicit `.dark` class wins, otherwise the OS preference.
 */
const readDocumentTheme = (): "light" | "dark" => {
  if (document.documentElement.classList.contains("dark")) return "dark";
  return globalThis.window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const hostContextFor = (theme: "light" | "dark"): McpUiHostContext => ({
  theme,
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  platform: "web",
});

export default function ArtifactShell(props: ArtifactRendererProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(INITIAL_FRAME_HEIGHT);
  const [theme, setTheme] = useState<"light" | "dark">(() => readDocumentTheme());

  // Read through refs inside the bridge: the bridge is built once per artifact,
  // and rebuilding it when the host identity changes would reload the iframe and
  // discard the rendered component.
  const hostRef = useRef(props.host as HttpShellHost);
  hostRef.current = props.host as HttpShellHost;
  const codeRef = useRef(props.code);
  codeRef.current = props.code;

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

  useEffect(() => {
    bridgeRef.current?.setHostContext(hostContextFor(theme));
  }, [theme]);

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
      { hostContext: hostContextFor(readDocumentTheme()) },
    );

    // Deliver the stored source the way a real host does after `create-artifact`: the
    // tool input, then the tool result carrying `structuredContent.code` — the
    // exact shape `renderedInAppResult` builds in the MCP host. The shell
    // already handles both, so it takes the same path here as it does under any
    // other MCP-Apps client, with no artifact-page-only branch.
    bridge.oninitialized = () => {
      const code = codeRef.current;
      void bridge
        .sendToolInput({ arguments: { code } })
        .then(() =>
          bridge.sendToolResult({
            content: [{ type: "text", text: "Rendered saved artifact." }],
            structuredContent: { code },
          }),
        )
        .catch((error: unknown) => {
          console.error("[executor-console] Failed to deliver the artifact to the shell:", error);
        });
    };

    // The app reports its content height; the host owns the frame's size. This
    // is the half that was missing inline — the page scrolls, the frame grows,
    // and nothing clips.
    bridge.onsizechange = (params) => {
      if (typeof params.height !== "number") return;
      setHeight(Math.max(MIN_FRAME_HEIGHT, Math.ceil(params.height)));
    };

    bridge.oncalltool = (params) =>
      hostRef.current.callServerTool({
        name: params.name,
        ...(params.arguments ? { arguments: params.arguments } : {}),
      });

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
    <iframe
      // Keyed on the source: opening a different artifact remounts the element,
      // which detaches the old bridge and attaches a fresh one to a fresh
      // document rather than reusing a shell that has already rendered
      // something else.
      key={props.code}
      ref={attachFrame}
      data-testid="artifact-shell-frame"
      title="Artifact"
      src={shellHtmlUrl}
      // The shell document is our own build, but it runs model-written JSX in a
      // further nested frame of its own. Scripts and same-origin are what it
      // needs to boot React and reach that inner frame; popups let `openLink`
      // escape the sandbox rather than silently failing. Deliberately absent:
      // `allow-top-navigation` (nothing in the shell navigates the console) and
      // `allow-forms` (nothing posts one).
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{ height }}
      // `min-h-full` against the page's scroll container: an artifact shorter
      // than the viewport still fills it (the shell's background matches the
      // console tokens, so the fill is seamless); a taller one grows to its
      // reported height and the page scrolls.
      className="block min-h-full w-full border-0 bg-background"
    />
  );
}
