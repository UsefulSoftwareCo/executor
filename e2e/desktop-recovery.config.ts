import { defineConfig } from "vitest/config";
import { scenarios } from "./test-plan.ts";
import { exactly } from "./scenario-parts.ts";

/**
 * The release workflow runs the desktop recovery scenarios in three parts, each on its own runner
 * with its own desktop build, so no two scenarios share a machine's clipboard, window focus, CPU or
 * process IDs. Each part takes about three and a half minutes; in one job they took eight to ten.
 * The starter deadline scenario waits out the desktop's three-minute deadline for a hung server
 * starter, so it runs alone; the others are split by their measured time (seconds, Linux x64,
 * Linux arm64 and macOS arm64, beta.44).
 */
const parts = [
  ["desktopStarterDeadline"], // 205, 199, 193
  [
    "desktopMigrationReplaced", // 65, 43, 47
    "desktopMigrationMoved", // 54, 29, 44
    "desktopCrashRecovery", // 32, 51, 27
    "desktopReset", // 20, 40, 17
    "desktopSlowStop", // 24, 26, 14
    "desktopClipboard",
  ],
  [
    "desktopMigrationReplacedClosed", // 50, 41, 46
    "desktopMigrationSettings", // 41, 44, 49
    "desktopDashboardRetry", // 24, 35, 23
    "desktopSharedService", // 34, 23, 9
    "desktopResetWithheld", // 15, 29, 18
    "desktopLateLoadFailure", // 11, 21, 10
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

/** EXECUTOR_E2E_DESKTOP_PART, `i/3`, runs part i; unset runs every scenario. */
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
    include: ["e2e/tests/desktop-recovery.spec.ts"],
    testTimeout: 180_000,
    // Each scenario owns a desktop window; keep them from competing for focus and CPU.
    fileParallelism: false,
    ...(selected === undefined
      ? {}
      : { testNamePattern: exactly(selected.map((key) => scenarios[key].title)) }),
  },
});
