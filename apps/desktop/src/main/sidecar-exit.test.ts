import { describe, expect, it } from "@effect/vitest";
import { classifySidecarExit, type SidecarExitInput } from "./sidecar-exit";

const classify = (overrides: Partial<SidecarExitInput> = {}) =>
  classifySidecarExit({
    code: null,
    signal: null,
    stoppedByUs: false,
    appQuitting: false,
    ...overrides,
  });

describe("classifySidecarExit", () => {
  it("classifies the SIGTERM stopSidecar sends as a managed stop", () => {
    expect(classify({ stoppedByUs: true, signal: "SIGTERM" })).toEqual({
      kind: "managed-stop",
      reason: "stopped-by-app",
    });
  });

  it("classifies any exit while the app is quitting as a managed stop", () => {
    // Quit tears the whole process tree down; whichever signal wins the race,
    // the sidecar going away is what we asked for.
    expect(classify({ appQuitting: true, code: 130 })).toEqual({
      kind: "managed-stop",
      reason: "app-quitting",
    });
    expect(classify({ appQuitting: true, code: 1 })).toEqual({
      kind: "managed-stop",
      reason: "app-quitting",
    });
  });

  it("classifies exit code 130 as an external shutdown rather than a crash", () => {
    // 128+SIGINT. Nothing in the app sends SIGINT, so it came from outside
    // (a group interrupt aimed at Electron) — an expected shutdown, not a crash.
    expect(classify({ code: 130 })).toEqual({
      kind: "external-shutdown",
      reason: "code 130",
    });
  });

  it("classifies a SIGINT signal exit as an external shutdown", () => {
    expect(classify({ code: null, signal: "SIGINT" })).toEqual({
      kind: "external-shutdown",
      reason: "SIGINT",
    });
  });

  it("classifies an unsolicited SIGTERM (code 143) as an external shutdown", () => {
    expect(classify({ code: 143 })).toEqual({
      kind: "external-shutdown",
      reason: "code 143",
    });
    expect(classify({ signal: "SIGTERM" })).toEqual({
      kind: "external-shutdown",
      reason: "SIGTERM",
    });
  });

  it("still classifies an ordinary non-zero exit as a crash", () => {
    expect(classify({ code: 1 })).toEqual({ kind: "crash" });
    expect(classify({ code: 7 })).toEqual({ kind: "crash" });
  });

  it("still classifies an abnormal death signal as a crash", () => {
    expect(classify({ signal: "SIGSEGV" })).toEqual({ kind: "crash" });
    expect(classify({ code: 134 })).toEqual({ kind: "crash" });
  });
});
