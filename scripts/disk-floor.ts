/**
 * Refuses to start a local e2e run or a local release build when the disk holding the working
 * directory has less free space than a floor. On a shared host a dozen agents write run evidence,
 * release builds and scratch to one disk; when it reached 0 every agent on it stopped mid-work.
 *
 * `bun run e2e:*` and `bun run release:cli`/`release:desktop` call this first, with what is
 * starting as the argument. The floor is `EXECUTOR_DISK_FLOOR_GB` (decimal GB), 20 by default;
 * `0` turns it off for someone who knows the run fits. A run writes up to about 1 GB of evidence
 * and a release build about 3 GB, so 20 GB leaves room for several to finish at once.
 *
 * In CI (`CI` set) the floor applies only when `EXECUTOR_DISK_FLOOR_GB` is set: a GitHub runner
 * starts with about 14 GB free on a fresh disk that nothing else shares, so the default would
 * refuse every job there for no benefit.
 */
import { statfsSync } from "node:fs";

const what = process.argv[2] ?? "this command";
const setting = process.env.EXECUTOR_DISK_FLOOR_GB ?? "";
if (setting === "" && process.env.CI) process.exit(0);
const floor = setting === "" ? 20 : Number(setting);
if (!Number.isFinite(floor) || floor < 0) {
  console.error(
    `${what}: not started: EXECUTOR_DISK_FLOOR_GB is "${setting}"; give a number of GB, or 0 to turn the floor off.`,
  );
  process.exit(1);
}
if (floor === 0) process.exit(0);
const disk = statfsSync(process.cwd());
const free = (Number(disk.bavail) * Number(disk.bsize)) / 1e9;
if (free < floor) {
  console.error(
    `${what}: not started: ${free.toFixed(1)} GB free on the disk holding ${process.cwd()}, below the ${floor} GB floor. Free space (old .local/e2e runs and .local/releases builds in idle workspaces, scratch in /tmp), or set EXECUTOR_DISK_FLOOR_GB=0 to start anyway.`,
  );
  process.exit(1);
}
