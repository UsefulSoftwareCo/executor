#!/usr/bin/env node
// The `executor` npm package's command. It starts the Executor executable from the platform
// package npm installed as an optional dependency, passes signals on, and exits as it exits. The
// executable carries its own runtime, so this file uses only what every Node since 14 has.
import { spawn } from "child_process";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const manifest = require("./package.json");
const name = "executor-" + process.platform + "-" + process.arch;
const channel = manifest.version.indexOf("-beta.") === -1 ? "" : "@beta";
const reinstall = "npm i -g executor" + channel + " --include=optional";

const fail = (lines) => {
  for (const line of lines) console.error(line);
  process.exit(1);
};

if (!Object.prototype.hasOwnProperty.call(manifest.optionalDependencies || {}, name))
  fail(["Executor does not support " + process.platform + "/" + process.arch + "."]);

let root;
try {
  root = dirname(require.resolve(name + "/package.json"));
} catch {
  // npm skips optional dependencies with --omit=optional, or when a lockfile made on another
  // platform did not list this one.
  fail([
    "Executor's native runtime is missing: " + name + " is not installed.",
    "Reinstall with optional dependencies: " + reinstall,
  ]);
}

const executable = join(root, process.platform === "win32" ? "executor.exe" : "executor");
const child = spawn(executable, process.argv.slice(2), {
  stdio: "inherit",
  env: Object.assign({}, process.env, {
    // How Executor was installed, for `executor upgrade` and its update notice.
    EXECUTOR_LAUNCHER: fileURLToPath(import.meta.url),
    EXECUTOR_LAUNCHER_NODE: process.versions.node,
  }),
});

// A terminal's Ctrl-C already reaches the whole process group, and on Windows every process on
// the console. A service manager signals only this process, so the signal is passed on. Windows
// has no signals to pass: killing the child there would end it at once, before its shutdown.
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
    "Reinstall with: " + reinstall,
  ]),
);
child.on("exit", (code, signal) => {
  for (const name of signals) process.removeListener(name, forward);
  // Ending by the same signal tells the shell what stopped Executor.
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});
