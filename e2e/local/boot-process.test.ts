import { describe, expect, it } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BootProcessExitError,
  BootReadinessTimeoutError,
  bootProcesses,
  isBootReadinessTimeout,
  waitForBoot,
} from "../setup/boot";
import { claimAndBoot, isAddrInUse } from "../src/ports";

describe("e2e boot process lifecycle", () => {
  it("fails immediately with the boot log when a child exits", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "executor-e2e-boot-"));
    const logFile = join(tempDir, "boot.log");
    let readinessProbeAborted = false;

    try {
      const processes = bootProcesses(
        [
          {
            cmd: process.execPath,
            args: [
              "-e",
              'console.error("Error: Port 44550 is already in use (EADDRINUSE)"); process.exit(17)',
            ],
            cwd: tempDir,
            logFile,
          },
        ],
        { label: "lifecycle-test" },
      );

      const startedAt = Date.now();
      let failure: unknown;
      try {
        await waitForBoot(
          processes,
          (signal) =>
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  readinessProbeAborted = true;
                  // oxlint-disable-next-line executor/no-promise-reject -- boundary: the fixture models an abort-aware readiness promise
                  reject(signal.reason);
                },
                { once: true },
              );
            }),
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(BootProcessExitError);
      expect(Date.now() - startedAt, "child exit beats the readiness timeout").toBeLessThan(5_000);
      expect(readinessProbeAborted, "the losing readiness probe is cancelled").toBe(true);
      expect(isAddrInUse(failure), "the port claimer can retry this boot failure").toBe(true);
      const bootFailure = failure as BootProcessExitError;
      expect(bootFailure.exitCode).toBe(17);
      expect(bootFailure.logTail).toContain("Port 44550 is already in use");

      await processes.teardown();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("releases a failed claim before retrying a readiness timeout", async () => {
    const envVar = "E2E_BOOT_LIFECYCLE_TEST_PORT";
    let attempts = 0;
    const claimedPorts: number[] = [];

    try {
      const booted = await claimAndBoot(
        [{ envVar, offset: 8, label: "boot lifecycle test" }],
        async (ports) => {
          attempts += 1;
          claimedPorts.push(ports[envVar]!);
          if (attempts === 1) {
            throw new BootReadinessTimeoutError("http://127.0.0.1:1", 10, "fixture timeout");
          }
          return { teardown: async () => {}, value: "ready" };
        },
        { maxAttempts: 2, label: "lifecycle-test", retryWhen: isBootReadinessTimeout },
      );

      expect(booted.value).toBe("ready");
      expect(attempts).toBe(2);
      expect(claimedPorts).toHaveLength(2);
      await booted.teardown();
      expect(process.env[envVar], "the successful claim is cleared at teardown").toBeUndefined();
    } finally {
      delete process.env[envVar];
    }
  });
});
