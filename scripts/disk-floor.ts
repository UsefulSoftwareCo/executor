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
