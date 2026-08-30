import { describe, expect, it } from "@effect/vitest";

import {
  OAUTH_POPUP_MESSAGE_TYPE,
  openOAuthPopup,
  openOAuthSystemBrowser,
  reserveOAuthPopup,
  type OAuthPopupResult,
} from "./oauth-popup";

type OAuthPopupTestWindow = {
  readonly screenX: number;
  readonly screenY: number;
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly location: { readonly origin: string };
  readonly addEventListener: () => void;
  readonly removeEventListener: () => void;
  readonly open: (
    url: string,
    name: string,
    features: string,
  ) => { closed: boolean; close: () => void; opener?: unknown; location: { href: string } };
};

type FakePopup = {
  closed: boolean;
  close: () => void;
  opener?: unknown;
  location: { href: string };
};

describe("openOAuthPopup", () => {
  it("does not open unsupported OAuth endpoint URLs", async () => {
    let openFailed = false;
    const teardown = openOAuthPopup({
      url: "javascript:alert(1)",
      popupName: "oauth",
      channelName: "oauth-channel",
      onResult: () => {},
      onOpenFailed: () => {
        openFailed = true;
      },
    });

    teardown();
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(openFailed).toBe(true);
  });

  it("opens supported OAuth URLs through a reserved popup with opener available", () => {
    let features = "";
    let opened = "";
    const popup: FakePopup = { closed: false, close: () => {}, location: { href: "" } };
    const previousWindow = globalThis.window;
    const fakeWindow: OAuthPopupTestWindow = {
      screenX: 0,
      screenY: 0,
      outerWidth: 1200,
      outerHeight: 900,
      location: { origin: "https://app.example" },
      addEventListener: () => {},
      removeEventListener: () => {},
      open: (url: string, _name: string, requestedFeatures: string) => {
        opened = url;
        features = requestedFeatures;
        return popup;
      },
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: fakeWindow,
      writable: true,
    });

    const teardown = openOAuthPopup({
      url: "https://auth.example/authorize",
      popupName: "oauth",
      channelName: "oauth-channel",
      onResult: () => {},
    });

    teardown();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
      writable: true,
    });
    expect(opened).toBe("about:blank");
    expect(popup.opener).toBeUndefined();
    expect(popup.location.href).toBe("https://auth.example/authorize");
    expect(features).toContain("popup=1");
    expect(features).not.toContain("noopener");
    expect(features).not.toContain("noreferrer");
  });

  it("can reserve the popup before an async authorization start", () => {
    let opened = "";
    const popup: FakePopup = { closed: false, close: () => {}, location: { href: "" } };
    const previousWindow = globalThis.window;
    const fakeWindow: OAuthPopupTestWindow = {
      screenX: 0,
      screenY: 0,
      outerWidth: 1200,
      outerHeight: 900,
      location: { origin: "https://app.example" },
      addEventListener: () => {},
      removeEventListener: () => {},
      open: (url: string) => {
        opened = url;
        return popup;
      },
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: fakeWindow,
      writable: true,
    });

    const reservedPopup = reserveOAuthPopup({ popupName: "oauth" });
    const teardown = openOAuthPopup({
      url: "https://auth.example/authorize",
      popupName: "oauth",
      channelName: "oauth-channel",
      reservedPopup: reservedPopup ?? undefined,
      onResult: () => {},
    });

    teardown();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
      writable: true,
    });
    expect(opened).toBe("about:blank");
    expect(reservedPopup).not.toBeNull();
    expect(popup.opener).toBeUndefined();
    expect(popup.location.href).toBe("https://auth.example/authorize");
  });

  it("opens HTTP authorization URLs returned by local flows", () => {
    let opened = "";
    const popup: FakePopup = { closed: false, close: () => {}, location: { href: "" } };
    const previousWindow = globalThis.window;
    const fakeWindow: OAuthPopupTestWindow = {
      screenX: 0,
      screenY: 0,
      outerWidth: 1200,
      outerHeight: 900,
      location: { origin: "http://127.0.0.1:4000" },
      addEventListener: () => {},
      removeEventListener: () => {},
      open: (url: string) => {
        opened = url;
        return popup;
      },
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: fakeWindow,
      writable: true,
    });

    const teardown = openOAuthPopup({
      url: "http://example.com/authorize",
      popupName: "oauth",
      channelName: "oauth-channel",
      onResult: () => {},
    });

    teardown();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
      writable: true,
    });
    expect(opened).toBe("about:blank");
    expect(popup.location.href).toBe("http://example.com/authorize");
  });

  it("can disable popup.closed polling for providers with strict opener policies", () => {
    let closedCalled = false;
    let intervalStarted = false;
    const popup: FakePopup = { closed: true, close: () => {}, location: { href: "" } };
    const previousWindow = globalThis.window;
    const previousSetInterval = globalThis.setInterval;
    const fakeWindow: OAuthPopupTestWindow = {
      screenX: 0,
      screenY: 0,
      outerWidth: 1200,
      outerHeight: 900,
      location: { origin: "https://app.example" },
      addEventListener: () => {},
      removeEventListener: () => {},
      open: () => popup,
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: fakeWindow,
      writable: true,
    });
    Object.defineProperty(globalThis, "setInterval", {
      configurable: true,
      value: () => {
        intervalStarted = true;
        return 1;
      },
      writable: true,
    });

    const teardown = openOAuthPopup({
      url: "https://auth.example/authorize",
      popupName: "oauth",
      channelName: "oauth-channel",
      closedPollMs: null,
      onResult: () => {},
      onClosed: () => {
        closedCalled = true;
      },
    });

    teardown();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
      writable: true,
    });
    Object.defineProperty(globalThis, "setInterval", {
      configurable: true,
      value: previousSetInterval,
      writable: true,
    });
    expect(intervalStarted).toBe(false);
    expect(closedCalled).toBe(false);
  });
});

describe("openOAuthSystemBrowser", () => {
  const sessionResult = (sessionId: string): OAuthPopupResult<unknown> => ({
    type: OAUTH_POPUP_MESSAGE_TYPE,
    ok: false,
    sessionId,
    error: "access denied",
  });

  const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(predicate()).toBe(true);
  };

  const withFakeFetch = async (fake: typeof fetch, run: () => Promise<void>): Promise<void> => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fake;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always restore the global fetch
    try {
      await run();
    } finally {
      globalThis.fetch = previousFetch;
    }
  };

  it("never stacks overlapping await requests while the server holds one open", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    let received: unknown = null;

    // Simulates a long-polling server: the request is held ~40ms, then
    // answers with the completed result.
    const fake: typeof fetch = async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      inFlight -= 1;
      return new Response(JSON.stringify(sessionResult("s-hold")));
    };

    await withFakeFetch(fake, async () => {
      const teardown = openOAuthSystemBrowser({
        url: "https://auth.example/authorize",
        sessionId: "s-hold",
        openExternal: async () => {},
        onResult: (result) => {
          received = result;
        },
        // Far shorter than the held request: the old setInterval loop would
        // stack many concurrent requests here.
        pollMs: 1,
      });
      await waitFor(() => received !== null);
      teardown();
    });

    expect(calls).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(received).toMatchObject({ sessionId: "s-hold" });
  });

  it("reconnects after a pending (null) answer and delivers the next result", async () => {
    let calls = 0;
    let received: unknown = null;

    // First request answers "still pending" (an old server, or a long-poll
    // deadline); the second delivers the result.
    const fake: typeof fetch = async () => {
      calls += 1;
      const body = calls === 1 ? null : sessionResult("s-retry");
      return new Response(JSON.stringify(body));
    };

    await withFakeFetch(fake, async () => {
      const teardown = openOAuthSystemBrowser({
        url: "https://auth.example/authorize",
        sessionId: "s-retry",
        openExternal: async () => {},
        onResult: (result) => {
          received = result;
        },
        pollMs: 1,
      });
      await waitFor(() => received !== null);
      teardown();
    });

    expect(calls).toBe(2);
    expect(received).toMatchObject({ sessionId: "s-retry" });
  });

  it("aborts the in-flight await request on teardown", async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };

    // Held open indefinitely; on abort it answers "still pending" the way a
    // real aborted fetch stops mattering — the loop is already settled.
    const fake: typeof fetch = (_input, init) =>
      new Promise<Response>((resolve) => {
        captured.signal = init?.signal ?? null;
        init?.signal?.addEventListener("abort", () => resolve(new Response("null")));
      });

    await withFakeFetch(fake, async () => {
      const teardown = openOAuthSystemBrowser({
        url: "https://auth.example/authorize",
        sessionId: "s-abort",
        openExternal: async () => {},
        onResult: () => {},
      });
      await waitFor(() => captured.signal !== null);
      teardown();
      await waitFor(() => captured.signal?.aborted === true);
    });

    expect(captured.signal?.aborted).toBe(true);
  });
});
