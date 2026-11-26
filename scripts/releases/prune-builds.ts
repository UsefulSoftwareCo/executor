import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statfsSync,
} from "node:fs";
import path from "node:path";
import { release } from "./config.ts";

const workspace = process.cwd();
const root = path.join(workspace, ".local/releases");
const kind = `${process.platform}-${process.arch}`;
const build = /^(.+)-(linux|darwin|win32)-(x64|arm64)$/;

const openPaths = (): ReadonlyArray<string> | undefined => {
  if (process.platform === "linux") {
    const paths: Array<string> = [];
    const read = (link: string) => {
      try {
        paths.push(readlinkSync(link));
      } catch {}
    };
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      for (const link of ["cwd", "exe", "root"]) read(`/proc/${pid}/${link}`);
      try {
        for (const fd of readdirSync(`/proc/${pid}/fd`)) read(`/proc/${pid}/fd/${fd}`);
        for (const line of readFileSync(`/proc/${pid}/maps`, "utf8").split("\n")) {
          const start = line.indexOf("/");
          if (start >= 0) paths.push(line.slice(start));
        }
      } catch {}
    }
    return paths;
  }
  if (process.platform === "darwin") {
    try {
      return execFileSync("lsof", ["-w", "-Fn"], { encoding: "utf8", maxBuffer: 256 * 1024 ** 2 })
        .split("\n")
        .filter((line) => line.startsWith("n/"))
        .map((line) => line.slice(1));
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const freeBytes = () => {
  const disk = statfsSync(workspace);
  return Number(disk.bavail) * Number(disk.bsize);
};

const prune = () => {
  if (process.env.CI) return;
  let names: Array<string>;
  try {
    if (realpathSync(root) !== path.join(realpathSync(workspace), ".local", "releases")) {
      console.error(`release: kept old builds: ${root} is or is under a symbolic link.`);
      return;
    }
    names = readdirSync(root);
  } catch {
    return;
  }
  const old = names.filter((name) => {
    const match = build.exec(name);
    if (match === null || `${match[2]}-${match[3]}` !== kind || match[1] === release.version)
      return false;
    const info = lstatSync(path.join(root, name));
    return info.isDirectory() && !info.isSymbolicLink();
  });
  if (old.length === 0) return;
  const open = openPaths();
  if (open === undefined) {
    console.error(`release: kept ${old.length} old ${kind} builds: cannot list open files here.`);
    return;
  }
  const before = freeBytes();
  const removed: Array<string> = [];
  for (const name of old) {
    const directory = path.join(root, name);
    if (open.some((file) => file === directory || file.startsWith(directory + path.sep))) {
      console.error(`release: kept ${name}: a running process has it open.`);
      continue;
    }
    try {
      rmSync(directory, { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      console.error(`release: could not remove ${name} (${(error as Error).message}).`);
    }
  }
  if (removed.length > 0)
    console.log(
      `release: removed ${removed.length} old ${kind} ${removed.length === 1 ? "build" : "builds"} (${Math.max(0, Math.round((freeBytes() - before) / 1024 ** 2))} MB freed) from ${root}: ${removed.join(", ")}. It keeps one build per platform.`,
    );
};

prune();
