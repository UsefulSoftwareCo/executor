// A synthetic browser URL bar, baked into the session recording itself.
//
// Playwright records the page viewport only (the recording is chromeless), so
// a shared `session.mp4` gives no hint of which URL each moment was on. The
// runs viewer reconstructs a URL bar from the nav timeline, but the raw video
// (the thing people actually pass around) had none. This injects a thin URL bar
// at the top of every top-level page so it shows up in the video AND the step
// screenshots, fed by `location.href` and updated across SPA route changes.
//
// It must not perturb the scenario: it renders inside a CLOSED shadow root
// (invisible to Playwright locators and the accessibility tree) and is
// `pointer-events: none` (never intercepts a click). The styling mirrors the
// viewer's synthetic chrome (traffic lights, #161b22 bar) so the in-viewer and
// standalone-video looks agree.
import type { BrowserContext } from "playwright";

/** Runs in the page before any app script, on every top-level document. */
function injectUrlBar(): void {
  // Top frame only (iframes should not each grow their own bar).
  if (window.top !== window.self) return;
  const flagged = window as Window & { __e2eUrlBar?: boolean };
  if (flagged.__e2eUrlBar) return;
  flagged.__e2eUrlBar = true;

  const BAR_H = 32;

  const install = (): void => {
    const root = document.documentElement;
    if (!root) return;

    const host = document.createElement("div");
    host.style.cssText = `position:fixed;top:0;left:0;width:100%;height:${BAR_H}px;z-index:2147483647;pointer-events:none`;
    const shadow = host.attachShadow({ mode: "closed" });

    const bar = document.createElement("div");
    bar.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:8px",
      `height:${BAR_H}px`,
      "box-sizing:border-box",
      "padding:0 12px",
      "background:#161b22",
      "border-bottom:1px solid #21262d",
      "font:13px/1 ui-monospace,SFMono-Regular,Menlo,monospace",
      "color:#c9d1d9",
      "white-space:nowrap",
      "overflow:hidden",
    ].join(";");

    const dot = (color: string): HTMLElement => {
      const d = document.createElement("span");
      d.style.cssText = `width:11px;height:11px;border-radius:50%;flex:none;background:${color}`;
      return d;
    };
    const lights = document.createElement("span");
    lights.style.cssText = "display:inline-flex;gap:6px;margin-right:4px";
    lights.append(dot("#ff5f57"), dot("#febc2e"), dot("#28c840"));

    const lock = document.createElement("span");
    lock.textContent = "⌁"; // the viewer's URL-bar glyph
    lock.style.cssText = "color:#8b949e;flex:none";

    const url = document.createElement("span");
    url.style.cssText = "overflow:hidden;text-overflow:ellipsis";

    bar.append(lights, lock, url);
    shadow.append(bar);
    root.appendChild(host);

    const render = (): void => {
      const next = location.href.replace(/^https?:\/\//, "") || "about:blank";
      if (url.textContent !== next) url.textContent = next;
    };
    render();

    // SPA route changes don't reload the document, so re-read the URL on every
    // history transition; the interval also re-attaches the bar if a framework
    // re-render detached it, and is the catch-all for navigations we can't hook.
    window.setInterval(() => {
      if (!root.contains(host)) root.appendChild(host);
      render();
    }, 250);
    for (const ev of ["popstate", "hashchange"] as const) window.addEventListener(ev, render);
    for (const name of ["pushState", "replaceState"] as const) {
      const orig = history[name] as (...args: unknown[]) => unknown;
      if (typeof orig === "function") {
        history[name] = function (this: History, ...args: unknown[]) {
          const result = orig.apply(this, args);
          render();
          return result;
        } as History[typeof name];
      }
    }
  };

  if (document.documentElement) install();
  else window.addEventListener("DOMContentLoaded", install, { once: true });
}

/**
 * Install the recording URL bar on a Playwright context. No-op on the desk
 * (E2E_DESK), where the browser is headed and already shows real chrome.
 */
export const installRecordingUrlBar = async (context: BrowserContext): Promise<void> => {
  if (process.env.E2E_DESK === "1") return;
  await context.addInitScript(injectUrlBar);
};
