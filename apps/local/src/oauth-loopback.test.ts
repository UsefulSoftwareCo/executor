import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  makeOAuthLoopbackListener,
  OAUTH_LOOPBACK_CLOSE_DELAY_MS,
  type LocalOAuthLoopbackListener,
} from "./oauth-loopback";

// ---------------------------------------------------------------------------
// The local daemon's loopback callback listener, over real sockets.
//
// The provider redirects a real browser to `http://127.0.0.1:<port><path>`; the
// listener hands that request to the daemon's own completion route, which owns
// completion and the completion page. These tests use real listeners and real
// HTTP requests — no stubs — because the thing under test IS the wire.
// ---------------------------------------------------------------------------

const openListeners: LocalOAuthLoopbackListener[] = [];
const openServers: { stop: (closeActiveConnections?: boolean) => void }[] = [];

afterEach(() => {
  for (const listener of openListeners.splice(0)) listener.closeAll();
  for (const server of openServers.splice(0)) server.stop(true);
});

/** A genuinely free port: bind one, read it, release it. */
const freePort = (): number => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  // A successful bind always has a port; the assertion only satisfies Bun's
  // optional-typed property (same shape as `serve.ts` reporting a live port).
  const port = probe.port!;
  probe.stop(true);
  return port;
};

const listening = (webBaseUrl: string): LocalOAuthLoopbackListener => {
  const listener = makeOAuthLoopbackListener(webBaseUrl);
  openListeners.push(listener);
  return listener;
};

describe("local loopback OAuth callback listener", () => {
  it("forwards the provider's callback to the daemon's completion route", async () => {
    const daemonPort = freePort();
    const callbackPort = freePort();
    const seen: string[] = [];
    openServers.push(
      Bun.serve({
        hostname: "127.0.0.1",
        port: daemonPort,
        fetch: (request) => {
          seen.push(new URL(request.url).pathname + new URL(request.url).search);
          return new Response("<html>completion</html>", {
            headers: { "content-type": "text/html" },
          });
        },
      }),
    );

    const webBaseUrl = `http://127.0.0.1:${daemonPort}`;
    const listener = listening(webBaseUrl);
    const callbackUrl = `http://127.0.0.1:${callbackPort}/callback`;

    await Effect.runPromise(listener.listen(callbackUrl));

    // What the provider's redirect does, verbatim: GET the loopback URI with the
    // code and the correlation state (plus a provider extra, which must survive).
    const redirect = await fetch(`${callbackUrl}?code=abc123&state=xyz&domain=datadoghq.eu`, {
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(
      `${webBaseUrl}/api/oauth/callback?code=abc123&state=xyz&domain=datadoghq.eu`,
    );

    // And it really lands on the daemon route.
    expect(await (await fetch(redirect.headers.get("location") ?? "")).text()).toContain(
      "completion",
    );
    expect(seen).toEqual(["/api/oauth/callback?code=abc123&state=xyz&domain=datadoghq.eu"]);
  });

  it("serves only the declared path", async () => {
    const callbackPort = freePort();
    const listener = listening(`http://127.0.0.1:${freePort()}`);
    await Effect.runPromise(listener.listen(`http://127.0.0.1:${callbackPort}/oauth/cb`));

    const wrongPath = await fetch(`http://127.0.0.1:${callbackPort}/callback?code=a&state=b`, {
      redirect: "manual",
    });
    expect(wrongPath.status).toBe(404);
    expect(await wrongPath.text()).toContain("/oauth/cb");

    const rightPath = await fetch(`http://127.0.0.1:${callbackPort}/oauth/cb?code=a&state=b`, {
      redirect: "manual",
    });
    expect(rightPath.status).toBe(302);
  });

  it("reports a port another process already holds, naming the likely culprit", async () => {
    const callbackPort = freePort();
    openServers.push(
      Bun.serve({ hostname: "127.0.0.1", port: callbackPort, fetch: () => new Response("taken") }),
    );

    const listener = listening(`http://127.0.0.1:${freePort()}`);
    const failure = await Effect.runPromise(
      Effect.flip(listener.listen(`http://127.0.0.1:${callbackPort}/callback`)),
    );
    expect(failure.message).toContain(`Port ${callbackPort} is already in use`);
    expect(failure.message).toContain("Claude Code");
  });

  it("reuses a listener already bound instead of contending with itself", async () => {
    const callbackPort = freePort();
    const listener = listening(`http://127.0.0.1:${freePort()}`);
    const url = `http://127.0.0.1:${callbackPort}/callback`;

    await Effect.runPromise(listener.listen(url));
    // A retry — the user reopens the connect dialog — must not fail on our own
    // port, and must leave the callback served.
    await Effect.runPromise(listener.listen(url));
    const redirect = await fetch(`${url}?code=a&state=b`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
  });

  it("releases the port when the flow is over", async () => {
    const callbackPort = freePort();
    const listener = listening(`http://127.0.0.1:${freePort()}`);
    await Effect.runPromise(listener.listen(`http://127.0.0.1:${callbackPort}/callback`));
    expect(
      (
        await fetch(`http://127.0.0.1:${callbackPort}/callback?code=a&state=b`, {
          redirect: "manual",
        })
      ).status,
    ).toBe(302);

    listener.closeAll();
    // Free again: the daemon can bind it, and nothing else can.
    const rebound = Bun.serve({
      hostname: "127.0.0.1",
      port: callbackPort,
      fetch: () => new Response("ok"),
    });
    openServers.push(rebound);
    expect(rebound.port).toBe(callbackPort);
  });

  it("keeps serving a URI two flows share after the first one completes", async () => {
    const daemonPort = freePort();
    const callbackPort = freePort();
    openServers.push(
      Bun.serve({
        hostname: "127.0.0.1",
        port: daemonPort,
        fetch: () => new Response("completion"),
      }),
    );
    const listener = listening(`http://127.0.0.1:${daemonPort}`);
    const url = `http://127.0.0.1:${callbackPort}/callback`;

    // Two flows start through the same app before either finishes — two tabs
    // connecting the same integration, which is what one declared URI means.
    await Effect.runPromise(listener.listen(url));
    await Effect.runPromise(listener.listen(url));

    const first = await fetch(`${url}?code=a&state=1`, { redirect: "manual" });
    expect(first.status).toBe(302);

    // The second user is still on the consent screen. If the first completion
    // had closed the listener, their redirect would hit a refused connection
    // after they finished signing in — the failure this guards.
    await new Promise((resolve) => setTimeout(resolve, OAUTH_LOOPBACK_CLOSE_DELAY_MS + 300));
    const second = await fetch(`${url}?code=b&state=2`, { redirect: "manual" });
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toContain("/api/oauth/callback?code=b&state=2");
  });

  it("closes behind a callback it served for a single flow", async () => {
    const callbackPort = freePort();
    const listener = listening(`http://127.0.0.1:${freePort()}`);
    const url = `http://127.0.0.1:${callbackPort}/callback`;
    await Effect.runPromise(listener.listen(url));
    expect((await fetch(`${url}?code=a&state=b`, { redirect: "manual" })).status).toBe(302);

    // One flow, one callback: the port goes back as soon as the browser has its
    // redirect, rather than waiting out the TTL.
    await new Promise((resolve) => setTimeout(resolve, OAUTH_LOOPBACK_CLOSE_DELAY_MS + 300));
    const rebound = Bun.serve({
      hostname: "127.0.0.1",
      port: callbackPort,
      fetch: () => new Response("ok"),
    });
    openServers.push(rebound);
    expect(rebound.port).toBe(callbackPort);
  });

  it("refuses a callback when the browser is not on this machine", async () => {
    const listener = listening("https://executor.example.com");
    const failure = await Effect.runPromise(
      Effect.flip(listener.listen(`http://127.0.0.1:${freePort()}/callback`)),
    );
    expect(failure.message).toContain("same machine as the browser");
  });
});
