import { describe, expect, it } from "@effect/vitest";
import {
  planCompletedUpdateCheck,
  planDownloadedUpdate,
  planFatalAutoInstallOnQuit,
  planUpdateCheck,
  handleUpdateDownloadRejection,
  statusAfterUpdateError,
} from "./updater-state";

describe("updater state decisions", () => {
  it("auto-prompts when a newer version arrives after the staged version was declined", () => {
    const decision = planDownloadedUpdate({
      stagedVersion: "1.5.27",
      declinedVersion: "1.5.27",
      incomingVersion: "1.5.28",
      trigger: "interval",
    });

    expect(decision).toEqual({
      stagedVersion: "1.5.28",
      declinedVersion: "1.5.27",
      status: { state: "downloaded", version: "1.5.28" },
      promptVersion: "1.5.28",
    });
  });

  it("keeps interval checks running without re-prompting the same declined version", () => {
    const check = planUpdateCheck({
      stagedVersion: "1.5.27",
      trigger: "interval",
    });
    const downloaded = planDownloadedUpdate({
      stagedVersion: "1.5.27",
      declinedVersion: "1.5.27",
      incomingVersion: "1.5.27",
      trigger: "interval",
    });

    expect(check).toEqual({ check: true, promptVersionAfterCheck: null });
    expect(downloaded.promptVersion).toBeNull();
  });

  it("manual checks re-check first and then re-prompt the staged version if no newer version wins", () => {
    const check = planUpdateCheck({
      stagedVersion: "1.5.27",
      trigger: "manual",
    });
    const completedWithoutNewer = planCompletedUpdateCheck({
      stagedVersion: check.promptVersionAfterCheck,
      trigger: "manual",
      updateAvailable: false,
      availableVersion: null,
    });
    const completedWithNewer = planCompletedUpdateCheck({
      stagedVersion: check.promptVersionAfterCheck,
      trigger: "manual",
      updateAvailable: true,
      availableVersion: "1.5.28",
    });

    expect(check.check).toBe(true);
    expect(completedWithoutNewer.promptVersion).toBe("1.5.27");
    expect(completedWithNewer.promptVersion).toBeNull();
  });

  it("moves active update failures to error while idle failures stay idle", () => {
    expect(
      statusAfterUpdateError(
        { state: "downloading", version: "1.5.27", percent: 42 },
        "Download failed",
      ),
    ).toEqual({
      state: "error",
      version: "1.5.27",
      message: "Download failed",
    });
    expect(statusAfterUpdateError({ state: "idle" }, "Download failed")).toEqual({
      state: "idle",
    });
  });

  it("handles auto-download promise rejections after update checks resolve", async () => {
    const errors: unknown[] = [];
    const failure = "bad signature";

    // oxlint-disable-next-line executor/no-promise-reject -- boundary: simulates electron-updater's native rejected download promise
    const handled = handleUpdateDownloadRejection(Promise.reject(failure), (error) => {
      errors.push(error);
    });

    await Promise.resolve();

    expect(handled).toBe(true);
    expect(errors).toEqual([failure]);
  });

  it("ignores missing auto-download promises", () => {
    expect(handleUpdateDownloadRejection(null, () => undefined)).toBe(false);
  });

  it("restores autoInstallOnAppQuit only when the fatal path recovers", () => {
    expect(
      planFatalAutoInstallOnQuit({
        packaged: true,
        retryAfterReset: true,
      }),
    ).toEqual({
      enableDuringFailure: true,
      restoreAfterRecovery: true,
    });
    expect(
      planFatalAutoInstallOnQuit({
        packaged: true,
        retryAfterReset: false,
      }),
    ).toEqual({
      enableDuringFailure: true,
      restoreAfterRecovery: false,
    });
  });
});
