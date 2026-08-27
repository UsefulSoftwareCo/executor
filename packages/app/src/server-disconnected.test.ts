/**
 * The recovery policy is tested against a fake environment in
 * preload-error.test.ts; this covers the environment the browser actually gets,
 * because a policy fed the wrong inputs recovers from nothing. The failure this
 * guards against is silent: a probe that answers backwards, or a reload guard
 * that never latches, turns "reload once" into a reload loop with every
 * behavioural test still green.
 */

import { afterEach, describe, expect, it } from "@effect/vitest";
import { browserEnvironment } from "./server-disconnected";

const BROWSER_GLOBALS = ["window", "document", "fetch", "reportError"] as const;
const originalGlobals = new Map<string, unknown>(
  BROWSER_GLOBALS.map((key) => [key, (globalThis as Record<string, unknown>)[key]]),
);

afterEach(() => {
  // The fakes below are installed on the real global object; leaving them there
  // would silently hand the next test a browser that does not exist.
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
});

class FakeElement {
  id = "";
  textContent = "";
  readonly style = { cssText: "" };
  readonly children: FakeElement[] = [];

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  byId(id: string): FakeElement | null {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.byId(id);
      if (found) return found;
    }
    return null;
  }

  get text(): string {
    return [this.textContent, ...this.children.map((child) => child.text)].join(" ").trim();
  }
}

interface FetchCall {
  readonly input: unknown;
  readonly init: RequestInit | undefined;
}

const environment = (options: {
  readonly respond?: () => Promise<{ ok: boolean; body: string }>;
  readonly storage?: "working" | "blocked";
}) => {
  const body = new FakeElement();
  const fetches: FetchCall[] = [];
  const reloads = { count: 0 };
  const reported: unknown[] = [];
  const store = new Map<string, string>();

  const sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  };

  const fakeWindow = {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: {
      reload: () => {
        reloads.count += 1;
      },
    },
  };
  if (options.storage === "blocked") {
    Object.defineProperty(fakeWindow, "sessionStorage", {
      get: () => {
        // oxlint-disable-next-line executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: reproduces the SecurityError a browser raises when storage is blocked
        throw new Error("SecurityError: storage is disabled");
      },
    });
  } else {
    Object.defineProperty(fakeWindow, "sessionStorage", { get: () => sessionStorage });
  }

  const globals = globalThis as Record<string, unknown>;
  globals.window = fakeWindow;
  globals.document = {
    body,
    createElement: () => new FakeElement(),
    getElementById: (id: string) => body.byId(id),
  };
  globals.fetch = async (input: unknown, init?: RequestInit) => {
    fetches.push({ input, init });
    const answer = await (options.respond?.() ?? Promise.resolve({ ok: true, body: "ok" }));
    return { ok: answer.ok, text: async () => answer.body };
  };
  globals.reportError = (error: unknown) => reported.push(error);

  return { env: browserEnvironment(), body, fetches, reloads, reported, store };
};

describe("browserEnvironment", () => {
  it("probes the unauthenticated health endpoint and believes only a healthy answer", async () => {
    const healthy = environment({ respond: async () => ({ ok: true, body: "ok\n" }) });
    expect(await healthy.env.probeServer()).toBe(true);
    expect(healthy.fetches).toHaveLength(1);
    expect(healthy.fetches[0]?.input).toBe("/api/health");
    // A cached 200 from before the server died would report it as alive.
    expect(healthy.fetches[0]?.init?.cache).toBe("no-store");

    const wrongBody = environment({ respond: async () => ({ ok: true, body: "<!doctype html>" }) });
    expect(await wrongBody.env.probeServer()).toBe(false);

    const failing = environment({ respond: async () => ({ ok: false, body: "" }) });
    expect(await failing.env.probeServer()).toBe(false);
  });

  it("reads a refused connection as a down server rather than propagating", async () => {
    const down = environment({
      respond: async () => {
        // oxlint-disable-next-line executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: fetch rejects when the origin is gone, which is the signal under test
        throw new TypeError("Failed to fetch");
      },
    });

    expect(await down.env.probeServer()).toBe(false);
  });

  it("shows one reconnect overlay however many times it is asked", () => {
    const { env, body } = environment({});

    env.showDisconnected();
    env.showDisconnected();

    const overlays = body.children.filter((child) => child.id === "executor-server-disconnected");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.text).toContain("Lost connection to the Executor server");
    expect(overlays[0]?.text).toContain("RECONNECTING");
  });

  it("latches the one-reload-per-session guard in storage", () => {
    const { env, store } = environment({});

    expect(env.readReloadFlag()).toBe(false);
    env.writeReloadFlag();

    expect(env.readReloadFlag()).toBe(true);
    expect([...store.keys()]).toEqual(["executor:preload-reloaded"]);
  });

  it("reports rather than reloads when storage is unavailable", () => {
    // Without a place to record the reload, an auto-reload could repeat
    // forever; reading the flag as already spent degrades to reporting once.
    const { env } = environment({ storage: "blocked" });

    expect(env.readReloadFlag()).toBe(true);
  });

  it("reloads the page and routes reports to the shared reporter", () => {
    const { env, reloads, reported } = environment({});
    // oxlint-disable-next-line executor/no-error-constructor -- test boundary: stands in for the chunk TypeError
    const failure = new TypeError("Failed to fetch dynamically imported module");

    env.reload();
    env.report(failure);

    expect(reloads.count).toBe(1);
    expect(reported).toEqual([failure]);
  });
});
