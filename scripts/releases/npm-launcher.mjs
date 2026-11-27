#!/usr/bin/env node
import { spawn, spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "fs";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { createRequire } from "module";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const manifest = require("./package.json");
const version = manifest.version;
const target = process.platform + "-" + process.arch;
const digest = (manifest.runtimes || {})[target];
const channel = version.indexOf("-beta.") === -1 ? "" : "@beta";
const executableName = process.platform === "win32" ? "executor.exe" : "executor";
const archive = "executor-" + version + "-" + target + ".tgz";
const downloads = (
  process.env.EXECUTOR_DOWNLOAD_URL ||
  "https://github.com/UsefulSoftwareCo/executor/releases/download"
).replace(/\/+$/, "");
const url = downloads + "/executor@" + version + "/" + archive;
const root = join(homedir(), ".executor", "v2", "launcher");
const installed = join(root, version);
const executable = join(installed, executableName);

const fail = (lines) => {
  for (const line of lines) console.error(line);
  process.exit(1);
};

if (typeof digest !== "string")
  fail(["Executor does not support " + process.platform + "/" + process.arch + "."]);

const get = (address, redirects) =>
  new Promise((resolve, reject) => {
    const request = (address.startsWith("http:") ? httpRequest : httpsRequest)(
      address,
      { headers: { "user-agent": "executor-launcher/" + version } },
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 10) return reject(new Error("too many redirects"));
          return resolve(get(new URL(response.headers.location, address).href, redirects + 1));
        }
        if (status !== 200) {
          response.resume();
          return reject(new Error("HTTP " + status));
        }
        resolve(response);
      },
    );
    request.setTimeout(60000, () => request.destroy(new Error("the connection stalled")));
    request.on("error", reject);
    request.end();
  });

const download = async (file) => {
  const response = await get(url, 0);
  const total = Number(response.headers["content-length"]) || 0;
  const hash = createHash("sha256");
  const out = createWriteStream(file);
  const tty = process.stderr.isTTY;
  let received = 0;
  let shown = -1;
  const label = "Downloading Executor " + version + " for " + target;
  if (!tty) console.error(label + " (first run of this version)");
  await new Promise((resolve, reject) => {
    response.on("data", (chunk) => {
      hash.update(chunk);
      received += chunk.length;
      const step = total ? Math.floor((received * 100) / total) : Math.floor(received / 1048576);
      if (tty && step !== shown) {
        shown = step;
        const amount = (received / 1048576).toFixed(1) + " MB";
        process.stderr.write(
          "\r\x1b[2K" + label + (total ? " " + step + "%" : "") + " (" + amount + ")",
        );
      }
    });
    response.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    response.pipe(out);
  });
  if (tty) process.stderr.write("\r\x1b[2K");
  return hash.digest("hex");
};

const prune = () => {
  const day = 24 * 60 * 60 * 1000;
  const entries = readdirSync(root)
    .filter((name) => name !== version)
    .map((name) => ({ name, time: statSync(join(root, name)).mtimeMs }));
  const versions = entries.filter((entry) => !entry.name.startsWith("."));
  versions.sort((left, right) => right.time - left.time);
  const stale = versions
    .slice(1)
    .concat(entries.filter((entry) => entry.name.startsWith(".") && Date.now() - entry.time > day));
  for (const entry of stale) {
    try {
      rmSync(join(root, entry.name), { recursive: true, force: true });
    } catch {}
  }
};

const install = async () => {
  mkdirSync(root, { recursive: true });
  const staging = join(root, ".download-" + process.pid + "-" + randomBytes(4).toString("hex"));
  mkdirSync(staging);
  const cleanup = () => rmSync(staging, { recursive: true, force: true });
  process.on("exit", cleanup);
  try {
    let actual;
    try {
      actual = await download(join(staging, archive));
    } catch (error) {
      fail([
        "Executor could not download its runtime from " + url + ": " + error.message + ".",
        "Check your connection and try again. EXECUTOR_DOWNLOAD_URL names a mirror of the releases.",
      ]);
    }
    if (actual !== digest)
      fail([
        archive +
          " does not match the SHA-256 this package records (expected " +
          digest +
          ", got " +
          actual +
          ").",
        "Nothing was installed. Check EXECUTOR_DOWNLOAD_URL, or reinstall with: npm i -g executor" +
          channel,
      ]);
    const tar =
      process.platform === "win32"
        ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
        : "tar";
    const unpacked = spawnSync(tar, ["-xzf", archive], {
      cwd: staging,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (unpacked.status !== 0)
      fail([
        "Executor could not unpack " +
          archive +
          " with " +
          tar +
          (unpacked.error ? ": " + unpacked.error.message : "."),
      ]);
    try {
      renameSync(join(staging, "package"), installed);
    } catch (error) {
      if (!existsSync(executable))
        fail([
          "Executor could not install its runtime in " + installed + ": " + error.message,
          "Remove " + installed + " and try again.",
        ]);
    }
    const now = new Date();
    utimesSync(installed, now, now);
  } finally {
    process.removeListener("exit", cleanup);
    cleanup();
  }
  try {
    prune();
  } catch {}
};

if (!existsSync(executable)) await install();

const child = spawn(executable, process.argv.slice(2), {
  stdio: "inherit",
  env: Object.assign({}, process.env, {
    EXECUTOR_LAUNCHER: fileURLToPath(import.meta.url),
    EXECUTOR_LAUNCHER_NODE: process.versions.node,
  }),
});

const signals =
  process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
const forward = (signal) => {
  if (process.platform !== "win32" && child.exitCode === null && child.signalCode === null)
    child.kill(signal);
};
for (const signal of signals) process.on(signal, forward);

child.on("error", (error) =>
  fail([
    "Executor could not start " + executable + ": " + error.message,
    "Remove " + installed + " to download it again.",
  ]),
);
child.on("exit", (code, signal) => {
  for (const name of signals) process.removeListener(name, forward);
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});
