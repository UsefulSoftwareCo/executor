import { describe, expect, it } from "@effect/vitest";

import { openOAuthPopup, reserveOAuthPopup } from "./oauth-popup";

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

  it("opens supported OAuth URLs through a reserved popup", () => {
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
    expect(popup.opener).toBe(null);
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
    expect(popup.opener).toBe(null);
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
