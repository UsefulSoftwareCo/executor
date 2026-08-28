import { afterEach, describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- boundary: vi.mock must come from vitest itself for mock hoisting to resolve
import { vi } from "vitest";
import * as Cause from "effect/Cause";

// oxlint-disable-next-line executor/no-error-constructor, executor/no-redundant-error-factory -- boundary: fixture for the adapter that turns raw thrown values into crash-report Errors
const rawError = (message: string): Error => new Error(message);

type Scope = {
  readonly setTag: (key: string, value: string) => unknown;
  readonly setContext: (key: string, value: Record<string, unknown> | null) => unknown;
};

const captured: Array<{
  readonly error: unknown;
  readonly tags: Record<string, string>;
  readonly contexts: Record<string, Record<string, unknown> | null>;
}> = [];

vi.mock("@sentry/browser", () => ({
  init: () => {},
  captureException: (error: unknown, configure: (scope: Scope) => Scope) => {
    const tags: Record<string, string> = {};
    const contexts: Record<string, Record<string, unknown> | null> = {};
    configure({
      setTag: (key, value) => (tags[key] = value),
      setContext: (key, value) => (contexts[key] = value),
    });
    captured.push({ error, tags, contexts });
    return "event-id";
  },
}));

const desktopBridge = {
  executor: {
    getCrashReporting: async () => ({
      dsn: "https://public@sentry.invalid/1",
      release: "0.0.0-test",
      environment: "test",
      runId: "run-test",
    }),
  },
};

const uiContext = { surface: "integrations", action: "connect" } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  captured.length = 0;
});

/**
 * The renderer used to pass no reporter at all, so handled UI errors fell
 * through to `globalThis.reportError`. Sentry's global `onerror` integration
 * then filed them as UNHANDLED crashes, titled from a `Data.TaggedError` with
 * no `message` field — `FrontendHandledError: No error message` — with the
 * surface/action context dropped entirely.
 */
describe("renderer handled-error reporting", () => {
  it("falls back to a global error event before Sentry is initialized", async () => {
    const reported: Array<unknown> = [];
    vi.stubGlobal("reportError", (error: unknown) => {
      reported.push(error);
    });

    const { reportRendererHandledError } = await import("./crash-reporting");
    reportRendererHandledError(Cause.die(rawError("connect failed")), uiContext);

    expect(reported).toHaveLength(1);
    // Nothing is lost in builds that never get a DSN: the fallback still
    // carries the failure text rather than an empty message.
    expect((reported[0] as Error).message).toContain("connect failed");
  });

  it("captures handled errors through Sentry once the desktop bridge supplies a DSN", async () => {
    vi.stubGlobal("window", desktopBridge);

    const module = await import("./crash-reporting");
    module.initDesktopCrashReporting();

    await vi.waitFor(() => {
      module.reportRendererHandledError(Cause.die(rawError("connect failed")), uiContext);
      expect(captured.length).toBeGreaterThan(0);
    });

    const event = captured[0]!;
    // A real Error, so the event has a title and groups on the failure rather
    // than on whichever minified frame reported it.
    expect(event.error).toBeInstanceOf(Error);
    expect((event.error as Error).message).toBe("connect failed");
    expect(event.tags["executor.ui.surface"]).toBe("integrations");
    expect(event.tags["executor.ui.action"]).toBe("connect");
    expect(event.contexts["executor.ui"]).toMatchObject({
      surface: "integrations",
      action: "connect",
    });
  });

  it("stays on the fallback when the desktop bridge is absent", async () => {
    vi.stubGlobal("window", {});
    const reported: Array<unknown> = [];
    vi.stubGlobal("reportError", (error: unknown) => {
      reported.push(error);
    });

    const module = await import("./crash-reporting");
    module.initDesktopCrashReporting();
    module.reportRendererHandledError("plain failure", uiContext);

    expect(captured).toHaveLength(0);
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toContain("plain failure");
  });
});
