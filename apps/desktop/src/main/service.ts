/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: Electron main process shells out to the bundled CLI and surfaces failures to boot/settings IPC callers */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import log from "electron-log/main.js";
import { sidecarCrashReportingEnv } from "./diagnostics";

const serviceLog = log.scope("service");
const execFileAsync = promisify(execFile);

export const SERVICE_LABEL = "sh.executor.daemon";

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SupervisedServiceStatus {
  readonly supported: boolean;
  readonly registered: boolean;
  readonly running: boolean;
}

export interface InstallOptions {
  readonly port: number;
  readonly dataDir: string;
}

export const bundledExecutorPath = (): string =>
  join(
    process.resourcesPath,
    "executor",
    process.platform === "win32" ? "executor.exe" : "executor",
  );

const executorAvailable = (): boolean => app.isPackaged && existsSync(bundledExecutorPath());

const captureUserPath = async (): Promise<string | undefined> => {
  const shell = process.env.SHELL;
  if (!shell) return process.env.PATH;
  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", 'printf "%s" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
    });
    const path = stdout.trim();
    return path.length > 0 ? path : process.env.PATH;
  } catch {
    return process.env.PATH;
  }
};

const serviceEnv = async (dataDir: string): Promise<NodeJS.ProcessEnv> => ({
  ...process.env,
  ...(await captureUserPath().then((path) => (path ? { PATH: path } : {}))),
  EXECUTOR_DATA_DIR: dataDir,
  EXECUTOR_SCOPE_DIR: dataDir,
  EXECUTOR_CLIENT: "desktop",
  ...sidecarCrashReportingEnv(),
});

const runExecutor = async (
  args: ReadonlyArray<string>,
  options: { readonly dataDir: string },
): Promise<CommandResult> => {
  const bin = bundledExecutorPath();
  try {
    const { stdout, stderr } = await execFileAsync(bin, [...args], {
      encoding: "utf8",
      env: await serviceEnv(options.dataDir),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string };
    if (typeof err.code === "string") {
      throw new Error(`Failed to run \`${bin}\`: ${err.code}`);
    }
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
};

const statusValue = (stdout: string, key: "Registered" | "Running"): boolean =>
  new RegExp(`^${key}:\\s+yes(?:\\s|$)`, "im").test(stdout);

export const supervisedServiceStatus = async (): Promise<SupervisedServiceStatus> => {
  if (!executorAvailable()) return { supported: false, registered: false, running: false };
  const dataDir = join(app.getPath("home"), ".executor");
  const result = await runExecutor(["service", "status"], { dataDir });
  if (result.code !== 0) {
    serviceLog.warn(`service status failed: ${result.stderr || result.stdout}`);
    return { supported: true, registered: false, running: false };
  }
  const supported = !/^Platform:\s+unsupported$/im.test(result.stdout);
  return {
    supported,
    registered: supported && statusValue(result.stdout, "Registered"),
    running: supported && statusValue(result.stdout, "Running"),
  };
};

export const installSupervisedService = async (opts: InstallOptions): Promise<void> => {
  if (!executorAvailable()) {
    throw new Error("Bundled executor binary is not available.");
  }
  const result = await runExecutor(["install", "--port", String(opts.port)], {
    dataDir: opts.dataDir,
  });
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || "`executor install` failed.");
  }
  serviceLog.info(`installed supervised service via bundled executor on port ${opts.port}`);
};

export const uninstallSupervisedService = async (dataDir: string): Promise<void> => {
  if (!executorAvailable()) return;
  const result = await runExecutor(["service", "uninstall"], { dataDir });
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout).trim() || "`executor service uninstall` failed.",
    );
  }
  serviceLog.info("uninstalled supervised service via bundled executor");
};

export const restartSupervisedService = async (): Promise<void> => {
  if (!executorAvailable()) {
    throw new Error("Bundled executor binary is not available.");
  }
  const dataDir = join(app.getPath("home"), ".executor");
  const result = await runExecutor(["service", "restart"], { dataDir });
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout).trim() || "`executor service restart` failed.",
    );
  }
};
