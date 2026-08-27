import { expect, test } from "@effect/vitest";

import { crashReportFingerprint, type CrashEvent } from "./crash-fingerprint";

// Chromium's soft-assert path (`NOTREACHED()`/`DCHECK`) dumps and keeps
// running. Sentry titles each one with the faulting load address, so one
// condition arrives as a new issue every time the address moves.
const softAssertEvent = (address: string): CrashEvent => ({
  exception: {
    values: [
      {
        type: "Fatal Error",
        value: `Simulated Exception / ${address}`,
        mechanism: { type: "minidump" },
        stacktrace: {
          frames: [
            { function: "logging::NotReachedLogMessage::~NotReachedLogMessage" },
            { function: "logging::HandleCheckErrorLogMessage" },
            { function: "base::debug::DumpWithoutCrashing" },
            { function: "crash_reporter::DumpWithoutCrashing" },
          ],
        },
      },
    ],
  },
});

test("address-keyed Chromium soft asserts collapse to one fingerprint", () => {
  const first = crashReportFingerprint(softAssertEvent("0x00000001a2b3c4d5"));
  const second = crashReportFingerprint(softAssertEvent("0x00000007e8f9a0b1"));

  expect(first).toEqual(["chromium-dump-without-crashing"]);
  expect(first).toEqual(second);
});

test("a real native abort keeps Sentry's own grouping", () => {
  const abortEvent: CrashEvent = {
    exception: {
      values: [
        {
          type: "EXC_CRASH",
          value: "SIGABRT",
          mechanism: { type: "minidump" },
          stacktrace: {
            frames: [
              { function: "abort" },
              { function: "pthread_kill" },
              { function: "__pthread_kill" },
            ],
          },
        },
      ],
    },
  };

  expect(crashReportFingerprint(abortEvent)).toBeUndefined();
});

test("renderer chunk hashes are normalized out of the fingerprint", () => {
  const rendererEvent = (chunkHash: string): CrashEvent => ({
    culprit: `loadConnections(assets/atoms-${chunkHash})`,
    exception: {
      values: [
        {
          type: "TypeError",
          value: "cannot read properties of undefined",
          stacktrace: {
            frames: [
              {
                filename: `http://127.0.0.1:4789/assets/atoms-${chunkHash}.js`,
                module: `atoms-${chunkHash}`,
                function: "loadConnections",
                in_app: true,
              },
            ],
          },
        },
      ],
    },
  });

  const release1 = crashReportFingerprint(rendererEvent("Yemn7yhP"));
  const release2 = crashReportFingerprint(rendererEvent("CeCENfWa"));

  expect(release1).toEqual(["TypeError", "loadConnections@atoms"]);
  expect(release1).toEqual(release2);
});

test("events with no volatile grouping input are left alone", () => {
  expect(crashReportFingerprint({})).toBeUndefined();
  expect(
    crashReportFingerprint({
      exception: {
        values: [
          {
            type: "Error",
            stacktrace: {
              frames: [{ filename: "/src/main/sidecar.ts", function: "startSidecar" }],
            },
          },
        ],
      },
    }),
  ).toBeUndefined();
});
