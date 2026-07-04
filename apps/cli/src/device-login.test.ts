import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  browserOpenCommand,
  discoverCliLogin,
  refreshDeviceTokens,
  requestDeviceCode,
  type CliLoginDiscovery,
} from "./device-login";

const originalFetch = globalThis.fetch;

interface FetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

const responseJson = (body: Record<string, unknown>, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const installFetch = (handler: (url: string, init: RequestInit | undefined) => Response) => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
};

const recordCall = (calls: Array<FetchCall>, url: string, init: RequestInit | undefined): void => {
  calls.push({
    url,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
  });
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("browserOpenCommand", () => {
  it("opens Windows browser URLs without cmd.exe", () => {
    const command = browserOpenCommand(
      "https://executor.example/login?next=a%20b&token=abc123",
      "win32",
    );

    expect(command).toEqual([
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", "https://executor.example/login?next=a%20b&token=abc123"],
    ]);
  });

  it("passes the browser URL as one argument on every platform", () => {
    expect(browserOpenCommand("https://executor.example/login?x=1&y=2", "darwin")).toEqual([
      "open",
      ["https://executor.example/login?x=1&y=2"],
    ]);
    expect(browserOpenCommand("https://executor.example/login?x=1&y=2", "linux")).toEqual([
      "xdg-open",
      ["https://executor.example/login?x=1&y=2"],
    ]);
  });

  it("refuses non-browser URL schemes", () => {
    expect(browserOpenCommand("javascript:alert(1)", "win32")).toBeUndefined();
    expect(browserOpenCommand("file:///C:/Windows/System32/calc.exe", "win32")).toBeUndefined();
    expect(browserOpenCommand("not a url", "win32")).toBeUndefined();
  });
});

describe("device login headers", () => {
  it("sends configured headers when discovering CLI login", async () => {
    const calls: Array<FetchCall> = [];
    installFetch((url, init) => {
      recordCall(calls, url, init);
      return responseJson({
        provider: "better-auth",
        deviceAuthorizationEndpoint: "https://executor.example/api/auth/device/code",
        tokenEndpoint: "https://executor.example/api/auth/device/token",
        clientId: "executor-cli",
        requestFormat: "json",
      });
    });

    const discovery = await discoverCliLogin("https://executor.example", {
      headers: { "CF-Access-Client-Id": "client-id" },
    });

    expect(discovery.clientId).toBe("executor-cli");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://executor.example/api/auth/cli-login");
    expect(calls[0]?.headers).toMatchObject({
      accept: "application/json",
      "cf-access-client-id": "client-id",
    });
  });

  it("sends configured headers only to same-origin device endpoints", async () => {
    const calls: Array<FetchCall> = [];
    installFetch((url, init) => {
      recordCall(calls, url, init);
      if (url.endsWith("/api/auth/device/code")) {
        return responseJson({
          device_code: "device-code",
          user_code: "USER-CODE",
          verification_uri: "https://executor.example/device",
          expires_in: 300,
          interval: 5,
        });
      }
      return responseJson({
        access_token: "access-token",
        refresh_token: "refresh-token-2",
        expires_in: 600,
      });
    });
    const discovery: CliLoginDiscovery = {
      provider: "better-auth",
      deviceAuthorizationEndpoint: "https://executor.example/api/auth/device/code",
      tokenEndpoint: "https://accounts.example/oauth/token",
      clientId: "executor-cli",
      requestFormat: "form",
    };
    const headers = { "CF-Access-Client-Id": "client-id" };

    await requestDeviceCode(discovery, { serverOrigin: "https://executor.example", headers });
    await refreshDeviceTokens({
      tokenEndpoint: discovery.tokenEndpoint,
      clientId: discovery.clientId,
      refreshToken: "refresh-token",
      serverOrigin: "https://executor.example",
      headers,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers).toMatchObject({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "cf-access-client-id": "client-id",
    });
    expect(calls[1]?.headers).toMatchObject({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(calls[1]?.headers["cf-access-client-id"]).toBeUndefined();
  });
});
