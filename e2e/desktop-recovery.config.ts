import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";
import { scenarios } from "./test-plan.ts";
import { exactly } from "./scenario-parts.ts";

const parts = [
  ["desktopStarterDeadline"],
  [
    "desktopMigrationReplaced",
    "desktopMigrationMoved",
    "desktopCrashRecovery",
    "desktopReset",
    "desktopSlowStop",
    "desktopClipboard",
  ],
  [
    "desktopMigrationReplacedClosed",
    "desktopMigrationSettings",
    "desktopDashboardRetry",
    "desktopSharedService",
    "desktopResetWithheld",
    "desktopLateLoadFailure",
  ],
] as const satisfies ReadonlyArray<ReadonlyArray<keyof typeof scenarios>>;

const file = "desktop-recovery.spec.ts";
const listed = parts.flat() as ReadonlyArray<keyof typeof scenarios>;
const unlisted = Object.entries(scenarios)
  .filter(([key, scenario]) => scenario.file === file && !listed.includes(key as never))
  .map(([key]) => key);
const elsewhere = listed.filter((key) => scenarios[key].file !== file);
const twice = listed.filter((key, index) => listed.indexOf(key) !== index);
if (unlisted.length + elsewhere.length + twice.length > 0)
  throw new Error(
    `Each ${file} scenario belongs to exactly one part in e2e/desktop-recovery.config.ts. Not in a part: ${unlisted.join(", ") || "none"}; not in ${file}: ${elsewhere.join(", ") || "none"}; in two parts: ${twice.join(", ") || "none"}.`,
  );

const part = process.env.EXECUTOR_E2E_DESKTOP_PART;
const index = part === undefined ? undefined : /^([1-9])\/(\d+)$/u.exec(part);
if (part !== undefined && (index === null || Number(index?.[2]) !== parts.length))
  throw new Error(
    `EXECUTOR_E2E_DESKTOP_PART is ${part}; use 1/${parts.length} to ${parts.length}/${parts.length}.`,
  );
const selected = index === undefined || index === null ? undefined : parts[Number(index[1]) - 1];
if (part !== undefined && selected === undefined)
  throw new Error(`EXECUTOR_E2E_DESKTOP_PART is ${part}; there are ${parts.length} parts.`);

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/desktop-recovery.spec.ts"],
    testTimeout: 180_000,
    fileParallelism: false,
    ...(selected === undefined
      ? {}
      : { testNamePattern: exactly(selected.map((key) => scenarios[key].title)) }),
    globalSetup: ["e2e/desktop-close-durations.ts"],
  },
});
