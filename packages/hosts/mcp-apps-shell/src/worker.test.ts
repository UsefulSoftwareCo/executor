import { describe, expect, it } from "@effect/vitest";

import { makeAssetsShellHtmlLoader, type ShellAssetsBinding } from "./worker";
import {
  MCP_APPS_SHELL_DOCUMENT_MARKER,
  MCP_APPS_SHELL_STABLE_ASSET_PATH,
} from "./shell-asset-path";

const SHELL_HTML = `<!doctype html><html><head><meta ${MCP_APPS_SHELL_DOCUMENT_MARKER} content="shell"></head><body><div id="root"></div></body></html>`;

const bindingReturning = (
  responses: readonly Response[],
): { readonly binding: ShellAssetsBinding; readonly requests: Request[] } => {
  const requests: Request[] = [];
  let call = 0;
  return {
    requests,
    binding: {
      fetch: (request) => {
        requests.push(request);
        const response = responses[Math.min(call, responses.length - 1)];
        call += 1;
        // Running out of scripted responses means the test was wrong about
        // how many fetches the loader makes; a distinctive 599 makes the
        // resulting assertion failure say so.
        return Promise.resolve(
          response ?? new Response("stub exhausted: unexpected fetch", { status: 599 }),
        );
      },
    },
  };
};

describe("makeAssetsShellHtmlLoader", () => {
  it("serves the shell from the stable asset path and caches it", async () => {
    const { binding, requests } = bindingReturning([new Response(SHELL_HTML)]);
    const load = makeAssetsShellHtmlLoader({ assets: binding });

    expect(await load()).toBe(SHELL_HTML);
    expect(await load()).toBe(SHELL_HTML);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(MCP_APPS_SHELL_STABLE_ASSET_PATH);
  });

  it("rejects on a non-OK response instead of serving a substitute document", async () => {
    const { binding } = bindingReturning([new Response("not found", { status: 404 })]);
    const load = makeAssetsShellHtmlLoader({ assets: binding });

    await expect(load()).rejects.toThrow(/404/);
    await expect(load()).rejects.toThrow(MCP_APPS_SHELL_STABLE_ASSET_PATH);
  });

  it("rejects a 200 that is not the shell (SPA not-found fallback)", async () => {
    // Under `not_found_handling: "single-page-application"` a miss answers
    // with the console's index.html and a 200 — the exact document that, if
    // served as the ui:// resource, hangs every client with no error.
    const { binding } = bindingReturning([
      new Response("<!doctype html><html><body><div id='app'>console</div></body></html>"),
    ]);
    const load = makeAssetsShellHtmlLoader({ assets: binding });

    await expect(load()).rejects.toThrow(/different document/);
  });

  it("prefers the dev document and never touches the binding when it is present", async () => {
    const { binding, requests } = bindingReturning([]);
    const load = makeAssetsShellHtmlLoader({
      assets: binding,
      devShellHtml: () => Promise.resolve(SHELL_HTML),
    });

    expect(await load()).toBe(SHELL_HTML);
    expect(requests).toHaveLength(0);
  });

  it("falls through to the binding when the dev document is undefined (a build)", async () => {
    const { binding } = bindingReturning([new Response(SHELL_HTML)]);
    const load = makeAssetsShellHtmlLoader({
      assets: binding,
      devShellHtml: () => Promise.resolve(undefined),
    });

    expect(await load()).toBe(SHELL_HTML);
  });
});
