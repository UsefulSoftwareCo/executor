import { afterEach, describe, expect, it } from "@effect/vitest";
import { OAUTH_CALLBACK_ORG_QUERY_PARAM } from "@executor-js/sdk/shared";

import { oauthCallbackUrl } from "./oauth-sign-in";

const originalWindow = globalThis.window;

const setLocation = (href: string): void => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: new URL(href) },
  });
};

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    return;
  }
  Reflect.deleteProperty(globalThis, "window");
});

describe("oauthCallbackUrl", () => {
  it("returns a relative callback path outside the browser", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(oauthCallbackUrl()).toBe("/api/oauth/callback");
  });

  it("carries the active org slug from the console URL", () => {
    setLocation("https://executor.sh/acme/integrations/posthog");

    const url = new URL(oauthCallbackUrl());

    expect(url.toString()).toBe("https://executor.sh/api/oauth/callback?executor_org=acme");
    expect(url.searchParams.get(OAUTH_CALLBACK_ORG_QUERY_PARAM)).toBe("acme");
  });

  it("does not add an org selector on bare app routes", () => {
    setLocation("https://executor.sh/login");

    expect(oauthCallbackUrl()).toBe("https://executor.sh/api/oauth/callback");
  });
});
