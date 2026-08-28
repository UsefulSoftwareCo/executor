import { describe, expect, it } from "@effect/vitest";
import {
  PRELOAD_ERROR_EVENT,
  installPreloadErrorHandler,
  respondToPreloadError,
  type PreloadErrorEnvironment,
} from "./preload-error";

interface Recorder {
  readonly env: PreloadErrorEnvironment;
  readonly calls: {
    probes: number;
    disconnected: number;
    reloads: number;
    reported: unknown[];
    flagWrites: number;
  };
}

const recorder = (options: {
  readonly serverUp: readonly boolean[];
  readonly reloadFlag?: boolean;
  readonly target?: EventTarget;
}): Recorder => {
  const calls = {
    probes: 0,
    disconnected: 0,
    reloads: 0,
    reported: [] as unknown[],
    flagWrites: 0,
  };
  let flag = options.reloadFlag ?? false;
  return {
    calls,
    env: {
      target: options.target ?? new EventTarget(),
      probeServer: async () => {
        const answer = options.serverUp[calls.probes] ?? options.serverUp.at(-1) ?? false;
        calls.probes += 1;
        return answer;
      },
      showDisconnected: () => {
        calls.disconnected += 1;
      },
      reload: () => {
        calls.reloads += 1;
      },
      report: (error) => {
        calls.reported.push(error);
      },
      readReloadFlag: () => flag,
      writeReloadFlag: () => {
        flag = true;
        calls.flagWrites += 1;
      },
      delay: async () => {},
    },
  };
};

// oxlint-disable-next-line executor/no-error-constructor -- test boundary: reproduces the exact TypeError the browser hands to vite:preloadError
const chunkError = new TypeError(
  "Failed to fetch dynamically imported module: http://127.0.0.1:4789/assets/route-abc123.js",
);

describe("respondToPreloadError", () => {
  it("shows the reconnect surface and never reports when the server is unreachable", async () => {
    // The sidecar died under a live window: the chunk fetch failing is a
    // symptom of that one event, already covered by the sidecar-exit path.
    const { env, calls } = recorder({ serverUp: [false, true] });

    const outcome = await respondToPreloadError(env, chunkError);

    expect(outcome).toBe("reconnected");
    expect(calls.disconnected).toBe(1);
    expect(calls.reported).toEqual([]);
    expect(calls.reloads).toBe(1);
    expect(calls.flagWrites).toBe(0);
  });

  it("reloads exactly once when the server answers and the chunk is genuinely stale", async () => {
    const { env, calls } = recorder({ serverUp: [true] });

    const outcome = await respondToPreloadError(env, chunkError);

    expect(outcome).toBe("reloaded");
    expect(calls.reloads).toBe(1);
    expect(calls.flagWrites).toBe(1);
    expect(calls.disconnected).toBe(0);
    expect(calls.reported).toEqual([]);
  });

  it("reports instead of looping when a reload already happened this session", async () => {
    const { env, calls } = recorder({ serverUp: [true], reloadFlag: true });

    const outcome = await respondToPreloadError(env, chunkError);

    expect(outcome).toBe("reported");
    expect(calls.reloads).toBe(0);
    expect(calls.reported).toEqual([chunkError]);
  });
});

describe("installPreloadErrorHandler", () => {
  it("prevents the default rejection so a dead chunk is not an unhandled TypeError", () => {
    const target = new EventTarget();
    const { env, calls } = recorder({ serverUp: [false, true], target });
    installPreloadErrorHandler(env);

    const event = new CustomEvent(PRELOAD_ERROR_EVENT, {
      cancelable: true,
      detail: { payload: chunkError },
    });
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(calls.probes).toBe(1);
  });

  it("stops responding after dispose", () => {
    const target = new EventTarget();
    const { env, calls } = recorder({ serverUp: [false, true], target });
    const dispose = installPreloadErrorHandler(env);
    dispose();

    target.dispatchEvent(
      new CustomEvent(PRELOAD_ERROR_EVENT, { cancelable: true, detail: { payload: chunkError } }),
    );

    expect(calls.probes).toBe(0);
  });
});
