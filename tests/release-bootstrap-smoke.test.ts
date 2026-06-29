import { describe, expect, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit } from "effect";

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const repoRoot = resolve(dirnameOf(import.meta.url), "..");
const cliRoot = join(repoRoot, "apps/cli");
const distDir = join(cliRoot, "dist");

function dirnameOf(url: string): string {
  return resolve(fileURLToPath(new URL(".", url)));
}

const runCommand = async (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> => {
  const child = spawn(command, [...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolveExitCode, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolveExitCode(code ?? -1);
    });
  });

  return { exitCode, stdout, stderr };
};

const listen = async (server: ReturnType<typeof createServer>): Promise<number> =>
  Effect.runPromise(
    Effect.callback<number, unknown>((resume) => {
      const onError = (cause: unknown) => resume(Effect.fail(cause));
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          resume(Effect.fail("Failed to resolve server address"));
          return;
        }
        resume(Effect.succeed(address.port));
      });
    }),
  );

const closeServer = async (server: ReturnType<typeof createServer>): Promise<void> =>
  Effect.runPromise(
    Effect.callback<void, unknown>((resume) => {
      server.close((error) => {
        if (error) {
          resume(Effect.fail(error));
          return;
        }
        resume(Effect.void);
      });
    }),
  );

const platformName = process.platform === "win32" ? "win32" : process.platform;
const archName = process.arch;
const currentPlatformPackage = `executor-${platformName}-${archName}`;
const currentRuntimeBinaryName = process.platform === "win32" ? "executor.exe" : "executor";
const isSupportedPlatform =
  ["darwin", "linux", "win32"].includes(process.platform) &&
  ["x64", "arm64"].includes(process.arch);

describe("release bootstrap smoke", () => {
  it("wrapper resolves the platform binary from optionalDependencies and stays runnable", async () => {
    if (!isSupportedPlatform) {
      return;
    }

    const build = await runCommand("bun", ["run", "src/build.ts", "binary", "--single"], cliRoot);
    expect(build.exitCode, build.stderr || build.stdout).toBe(0);

    const wrapperDir = join(distDir, "executor");
    const platformDir = join(distDir, currentPlatformPackage);

    // Simulate the install layout npm/bun produces:
    //   <root>/executor/                <- wrapper (bin, postinstall, package.json)
    //   <root>/executor/node_modules/executor-<plat>-<arch>/  <- platform package
    const tempRoot = await mkdtemp(join(tmpdir(), "executor-optdeps-bootstrap-"));
    const installedWrapperDir = join(tempRoot, "executor");
    const installedPlatformDir = join(installedWrapperDir, "node_modules", currentPlatformPackage);
    const dataDir = join(tempRoot, "data");

    await cp(wrapperDir, installedWrapperDir, { recursive: true });
    await mkdir(join(installedWrapperDir, "node_modules"), { recursive: true });
    await cp(platformDir, installedPlatformDir, { recursive: true });

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: release smoke test must clean temp install files after process checks
    try {
      const firstRun = await runCommand(
        process.execPath,
        [join(installedWrapperDir, "bin", "executor"), "--help"],
        installedWrapperDir,
      );
      const combined = `${firstRun.stdout}\n${firstRun.stderr}`;
      expect(firstRun.exitCode, combined).toBe(0);
      expect(combined).not.toContain("could not locate a platform binary");
      expect(combined).not.toContain("ENOENT");

      // The platform binary lives under node_modules/<platform-pkg>/bin/.
      const platformBinaryPath = join(installedPlatformDir, "bin", currentRuntimeBinaryName);
      const platformBinaryStat = await readFile(platformBinaryPath);
      expect(platformBinaryStat.byteLength).toBeGreaterThan(0);

      // Boot the web command and check that the bundled web UI serves.
      const probeServer = createServer((_, response) => {
        response.statusCode = 204;
        response.end();
      });
      const webPort = await listen(probeServer);
      await closeServer(probeServer);

      const webProcess = spawn(
        process.execPath,
        [
          join(installedWrapperDir, "bin", "executor"),
          "web",
          "--foreground",
          "--port",
          String(webPort),
        ],
        {
          cwd: installedWrapperDir,
          env: {
            ...process.env,
            EXECUTOR_DATA_DIR: dataDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let webStdout = "";
      let webStderr = "";
      webProcess.stdout.setEncoding("utf8");
      webProcess.stdout.on("data", (chunk) => {
        webStdout += chunk;
      });
      webProcess.stderr.setEncoding("utf8");
      webProcess.stderr.on("data", (chunk) => {
        webStderr += chunk;
      });

      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: release smoke test must stop the spawned web process
      try {
        const deadline = Date.now() + 30_000;
        let rootResponse: Response | null = null;
        while (Date.now() < deadline) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
          const fetchExit = await Effect.runPromiseExit(
            Effect.tryPromise(() => fetch(`http://127.0.0.1:${webPort}/`)),
          );
          if (Exit.isSuccess(fetchExit)) {
            rootResponse = fetchExit.value;
            if (rootResponse.ok) {
              break;
            }
          }
        }

        expect(rootResponse, `${webStdout}\n${webStderr}`).not.toBeNull();
        expect(rootResponse!.status, `${webStdout}\n${webStderr}`).toBe(200);
        const rootHtml = await rootResponse!.text();
        expect(rootHtml.toLowerCase()).toContain("<html");

        const assetJs = rootHtml.match(/src="([^"]+\.js)"/)?.[1];
        const assetCss = rootHtml.match(/href="([^"]+\.css)"/)?.[1];
        expect(assetJs, rootHtml).toBeDefined();
        expect(assetCss, rootHtml).toBeDefined();

        const assetJsResponse = await fetch(`http://127.0.0.1:${webPort}${assetJs}`);
        expect(assetJsResponse.status, `${webStdout}\n${webStderr}`).toBe(200);

        const assetCssResponse = await fetch(`http://127.0.0.1:${webPort}${assetCss}`);
        expect(assetCssResponse.status, `${webStdout}\n${webStderr}`).toBe(200);

        const docsResponse = await fetch(`http://127.0.0.1:${webPort}/docs`);
        expect(docsResponse.status, `${webStdout}\n${webStderr}`).toBe(200);

        // Sanity: a second invocation still works (the cache shouldn't
        // break anything if it was created).
        const secondRun = await runCommand(
          process.execPath,
          [join(installedWrapperDir, "bin", "executor"), "--help"],
          installedWrapperDir,
        );
        expect(secondRun.exitCode, `${secondRun.stdout}\n${secondRun.stderr}`).toBe(0);
      } finally {
        webProcess.kill("SIGTERM");
        await Promise.race([
          new Promise((resolveClose) => webProcess.once("close", () => resolveClose(undefined))),
          new Promise((resolveClose) => setTimeout(resolveClose, 5_000)),
        ]);
        if (webProcess.exitCode === null) {
          if (process.platform === "win32") {
            webProcess.kill();
          } else {
            webProcess.kill("SIGKILL");
          }
        }
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
