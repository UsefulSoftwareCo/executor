import { Sandbox as VercelSandboxSDK } from "@vercel/sandbox";
import type { Dirent } from "fs";
import type { ExecResult, Sandbox, SandboxHooks, SandboxStats, SnapshotResult } from "../interface";
import type { SandboxStatus } from "../types";
import type { VercelSandboxConfig, VercelSandboxConnectConfig } from "./config";
import {
  DEFAULT_WORKING_DIRECTORY,
  TIMEOUT_BUFFER_MS,
  emitSetupEvent,
  prepareVercelSandboxSetup,
  syncGitHubCredentialBrokering,
  type VercelSandboxSession,
} from "./setup";
import type { VercelState } from "./state";

const MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 300_000; // 5 minutes default timeout for reconnected sandboxes
const DETACHED_QUICK_FAILURE_WINDOW_MS = 2_000;

function isStoppedSessionStatus(status: string | undefined): boolean {
  return (
    status === "stopped" ||
    status === "stopping" ||
    status === "snapshotting" ||
    status === "aborted" ||
    status === "failed"
  );
}

function getRemainingTimeoutFromSession(session: VercelSandboxSession): number | undefined {
  const timeout = session.timeout;
  if (typeof timeout !== "number" || timeout <= 0) {
    return undefined;
  }

  const startedAt = session.startedAt?.getTime() ?? session.requestedAt?.getTime();
  if (typeof startedAt !== "number") {
    return undefined;
  }

  const proactiveTimeout = Math.max(timeout - TIMEOUT_BUFFER_MS, 0);
  const remaining = startedAt + proactiveTimeout - Date.now();
  return remaining > 10_000 ? remaining : undefined;
}

function truncateCommandOutput(output: string): {
  output: string;
  truncated: boolean;
} {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return { output, truncated: false };
  }

  return {
    output: output.slice(0, MAX_OUTPUT_LENGTH),
    truncated: true,
  };
}

/**
 * Vercel Sandbox implementation using the @vercel/sandbox SDK.
 * Runs code in isolated Firecracker MicroVMs.
 */
export class VercelSandbox implements Sandbox {
  readonly type = "cloud" as const;
  /** Durable persistent sandbox name. */
  readonly name: string;
  /** Current runtime session identifier. */
  readonly id: string;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  /**
   * The current git branch in the sandbox.
   * Set when a newBranch is created, or when cloning from a specific branch.
   */
  readonly currentBranch?: string;
  readonly hooks?: SandboxHooks;

  private sdk: VercelSandboxSDK;
  private session: VercelSandboxSession;
  private timeoutTimer?: ReturnType<typeof setTimeout>;
  private isStopped = false;
  private _expiresAt?: number;
  private _timeout?: number;
  private _ports?: number[];

  /**
   * Timestamp (ms since epoch) when this sandbox will be proactively stopped.
   * This value is updated when timeout is extended via extendTimeout().
   */
  get expiresAt(): number | undefined {
    return this._expiresAt;
  }

  /**
   * The initial configured proactive timeout duration in milliseconds.
   * Note: This is the original timeout value, not affected by extendTimeout() calls.
   * Use expiresAt to get the current expiration time.
   */
  get timeout(): number | undefined {
    return this._timeout;
  }

  private constructor(
    sdk: VercelSandboxSDK,
    session: VercelSandboxSession,
    name: string,
    id: string,
    workingDirectory: string,
    env?: Record<string, string>,
    currentBranch?: string,
    hooks?: SandboxHooks,
    timeout?: number,
    startTime?: number,
    ports?: number[],
  ) {
    this.sdk = sdk;
    this.session = session;
    this.name = name;
    this.id = id;
    this.workingDirectory = workingDirectory;
    this.env = env;
    this.currentBranch = currentBranch;
    this.hooks = hooks;
    this._ports = ports;
    this.isStopped = isStoppedSessionStatus(session.status);

    // Set timeout tracking for proactive stop
    if (!this.isStopped && timeout !== undefined && startTime !== undefined) {
      this._timeout = timeout;
      this._expiresAt = startTime + timeout;
      this.scheduleProactiveStop();
    }
  }

  private refreshStateFromCurrentSession(): void {
    const currentSession = this.sdk.currentSession();
    const nextIsStopped = isStoppedSessionStatus(currentSession.status);
    const shouldRefresh =
      currentSession.sessionId !== this.session.sessionId ||
      nextIsStopped !== this.isStopped ||
      (!nextIsStopped && this._expiresAt === undefined);

    if (!shouldRefresh) {
      return;
    }

    this.session = currentSession;
    this.isStopped = nextIsStopped;

    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }

    if (this.isStopped) {
      this._timeout = undefined;
      this._expiresAt = undefined;
      return;
    }

    const remainingTimeout =
      getRemainingTimeoutFromSession(currentSession) ?? DEFAULT_RECONNECT_TIMEOUT_MS;
    this._timeout = remainingTimeout;
    this._expiresAt = Date.now() + remainingTimeout;
    this.scheduleProactiveStop();
  }

  /**
   * Schedule a timer to call onTimeout hook before the SDK timeout.
   * Note: This does NOT call stop() - the client is responsible for stopping.
   * The TIMEOUT_BUFFER_MS gives the client time to save and stop after their countdown ends.
   */
  private scheduleProactiveStop(): void {
    if (this._expiresAt === undefined) return;

    const msUntilTimeout = this._expiresAt - Date.now();
    if (msUntilTimeout <= 0) return;

    this.timeoutTimer = setTimeout(async () => {
      try {
        if (this.isStopped) return;

        // Call onTimeout hook if configured (for CLI usage)
        if (this.hooks?.onTimeout) {
          try {
            await this.hooks.onTimeout(this);
          } catch (error) {
            console.error(
              "[VercelSandbox] onTimeout hook failed:",
              error instanceof Error ? error.message : error,
            );
          }
        }

        // Don't call stop() here - let the client handle it.
        // The SDK timeout (with TIMEOUT_BUFFER_MS) is the safety net.
      } catch (error) {
        console.warn(
          "[VercelSandbox] onTimeout handler failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }, msUntilTimeout);
  }

  /**
   * Clear existing timeout timer and schedule a new one.
   */
  private rescheduleProactiveStop(): void {
    // Clear existing timer
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
    // Schedule new timer
    this.scheduleProactiveStop();
  }

  /**
   * Extend the sandbox timeout by the specified duration.
   * @param additionalMs - Additional time in milliseconds
   * @returns New expiration timestamp
   */
  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    if (this.isStopped) {
      throw new Error("Cannot extend timeout on stopped sandbox");
    }
    if (this._expiresAt === undefined) {
      throw new Error("Timeout tracking not enabled for this sandbox");
    }

    await this.sdk.extendTimeout(additionalMs);
    this.session = this.sdk.currentSession();

    // Update internal state
    this._expiresAt += additionalMs;

    // Reschedule proactive stop timer
    this.rescheduleProactiveStop();

    // Call hook if provided
    if (this.hooks?.onTimeoutExtended) {
      try {
        await this.hooks.onTimeoutExtended(this, additionalMs);
      } catch (error) {
        console.error(
          "[VercelSandbox] onTimeoutExtended hook failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    return { expiresAt: this._expiresAt };
  }

  /**
   * The base host/domain for this sandbox (e.g., "abc123.vercel.run").
   * To get the full URL for an exposed port, use the `domain(port)` method
   * which returns the correct subdomain-based URL for that port.
   */
  get host(): string | undefined {
    const candidatePorts = this.getCandidatePorts();

    for (const port of candidatePorts) {
      try {
        const domainUrl = this.sdk.domain(port);
        return new URL(domainUrl).host;
      } catch {
        // Try next declared port; some restored sandboxes may not expose all ports.
      }
    }

    // Fallback for cases where no ports were declared but default HTTP route exists.
    if (!candidatePorts.includes(80)) {
      try {
        const domainUrl = this.sdk.domain(80);
        return new URL(domainUrl).host;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  get environmentDetails(): string {
    const host = this.host;
    const previewPorts = this.getPreviewPorts();
    const portPreviewLines =
      previewPorts
        ?.map((port) => {
          try {
            const url = this.domain(port);
            return `  - Port ${port}: ${url}`;
          } catch {
            return undefined;
          }
        })
        .filter((line): line is string => line !== undefined) ?? [];

    const portLines = portPreviewLines.length
      ? `\n- Dev server URLs for locally running servers (start a server on one of these ports, then share the URL with the user):\n${portPreviewLines.join("\n")}`
      : "";

    const hostLine = host ? `\n- Sandbox host: ${host}` : "";
    const runtimeEnvLine =
      host || previewPorts.length > 0
        ? "\n- Runtime env vars for dev server URLs are injected into commands: SANDBOX_HOST and SANDBOX_URL_<PORT> (for routable ports)"
        : "";

    return `- Sandbox VMs are temporary, but named sandboxes can be hibernated and later resumed from their persisted filesystem state
- All bash commands already run in the working directory by default — never prepend \`cd <working-directory> &&\`; just run the command directly
- Do NOT prefix any bash command with a \`cd\` to the working directory — commands like \`cd <working-directory> && npm test\` are WRONG; just use \`npm test\`
- Use workspace-relative paths for read/write/search/edit operations
- Git is available for local inspection only; do not configure remotes or credentials
- GitHub CLI (gh) is NOT available; do not call GitHub write APIs from this sandbox
- GitHub writes are handled by the broker outside this sandbox. Do not configure credentials, commit, or push from inside the sandbox.
- Node.js runtime with npm/pnpm available
- Bun and jq are preinstalled
- Dependencies may not be installed. Before running project scripts (build, typecheck, lint, test), check if \`node_modules\` exists and run the package manager install command if needed (e.g. \`bun install\`, \`npm install\`)
- This snapshot includes agent-browser; when validating UI or end-to-end behavior, start the dev server and use agent-browser against the local dev server URL
- This sandbox already runs on Vercel; do not suggest deploying to Vercel just to obtain a shareable preview link
${hostLine}${portLines}${runtimeEnvLine}`;
  }

  private getRoutePorts(): number[] {
    return this.sdk.routes
      .map((route) => route.port)
      .filter((port) => Number.isInteger(port) && port > 0);
  }

  private getPreviewPorts(): number[] {
    return Array.from(new Set([...(this._ports ?? []), ...this.getRoutePorts()]));
  }

  private getCandidatePorts(): number[] {
    return Array.from(new Set([...this.getPreviewPorts(), 80]));
  }

  private getRuntimePreviewEnv(): Record<string, string> {
    const runtimeEnv: Record<string, string> = {};
    const host = this.host;
    if (host) {
      runtimeEnv.SANDBOX_HOST = host;
    }

    for (const port of this.getPreviewPorts()) {
      try {
        runtimeEnv[`SANDBOX_URL_${port}`] = this.domain(port);
      } catch {
        // Skip unroutable ports
      }
    }

    return runtimeEnv;
  }

  private getCommandEnv(): Record<string, string> | undefined {
    const runtimePreviewEnv = this.getRuntimePreviewEnv();
    if (!this.env && Object.keys(runtimePreviewEnv).length === 0) {
      return undefined;
    }

    return {
      ...this.env,
      ...runtimePreviewEnv,
    };
  }

  /**
   * Create a new Vercel Sandbox instance.
   * If `baseSnapshotId` is provided, sandbox bootstraps from that snapshot first.
   * If a source is provided with `baseSnapshotId`, the repo is cloned after bootstrap.
   * Use `skipGitWorkspaceBootstrap` when preparing a new base snapshot so the workspace
   * stays free of `.git` for subsequent clones.
   */
  static async create(config: VercelSandboxConfig = {}): Promise<VercelSandbox> {
    const setup = await prepareVercelSandboxSetup(config);
    const sandbox = new VercelSandbox(
      setup.sdk,
      setup.session,
      setup.sdk.name,
      setup.session.sessionId,
      setup.workingDirectory,
      config.env,
      setup.currentBranch,
      config.hooks,
      setup.effectiveTimeout,
      setup.startTime,
      config.ports,
    );

    if (config.hooks?.afterStart) {
      await emitSetupEvent(config.onSetupEvent, {
        phase: "after-start-hook-start",
        sandboxName: setup.sdk.name,
      });
      await config.hooks.afterStart(sandbox);
      await emitSetupEvent(config.onSetupEvent, {
        phase: "after-start-hook-complete",
        sandboxName: setup.sdk.name,
      });
    }

    return sandbox;
  }

  /**
   * Connect to an existing Vercel Sandbox by persistent name.
   */
  static async connect(
    sandboxName: string,
    options: {
      env?: Record<string, string>;
      githubToken?: string;
      hooks?: SandboxHooks;
      /**
       * Remaining timeout in ms for this sandbox session.
       * If not provided, it is derived from the live session metadata when possible.
       */
      remainingTimeout?: number;
      /** Ports that were declared at creation time (for preview URL display) */
      ports?: number[];
      /** Whether to explicitly resume a stopped sandbox */
      resume?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<VercelSandbox> {
    const sdk = await VercelSandboxSDK.get({
      name: sandboxName,
      resume: options.resume ?? false,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await syncGitHubCredentialBrokering(sdk, undefined, options.signal);
    const session = sdk.currentSession();

    // Use provided remainingTimeout when available; otherwise derive it from the
    // current live session. Fall back to the default reconnect timeout so active
    // sessions still get proactive stop tracking even if metadata is missing.
    const remainingTimeout =
      options.remainingTimeout ??
      getRemainingTimeoutFromSession(session) ??
      (isStoppedSessionStatus(session.status) ? undefined : DEFAULT_RECONNECT_TIMEOUT_MS);
    const startTime = remainingTimeout !== undefined ? Date.now() : undefined;

    const sandbox = new VercelSandbox(
      sdk,
      session,
      sandboxName,
      session.sessionId,
      DEFAULT_WORKING_DIRECTORY,
      options.env,
      undefined,
      options.hooks,
      remainingTimeout,
      startTime,
      options.ports,
    );

    // Call afterStart hook if provided (useful for reconnection setup)
    if (options.hooks?.afterStart) {
      await options.hooks.afterStart(sandbox);
    }

    return sandbox;
  }

  async readFile(path: string, _encoding: "utf-8"): Promise<string> {
    // Use the SDK's native readFileToBuffer method which handles streaming
    // internally, avoiding the command output size limit that can occur with
    // large files when using `cat` via runCommand.
    const buffer = await this.sdk.readFileToBuffer({ path });

    if (buffer === null) {
      throw new Error(`Failed to read file: ${path}`);
    }

    return buffer.toString("utf-8");
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    const buffer = await this.sdk.readFileToBuffer({ path });

    if (buffer === null) {
      throw new Error(`Failed to read file: ${path}`);
    }

    return buffer;
  }

  async writeFile(path: string, content: string, _encoding: "utf-8"): Promise<void> {
    // Ensure parent directory exists
    const parentDir = path.substring(0, path.lastIndexOf("/"));
    if (parentDir) {
      await this.mkdir(parentDir, { recursive: true });
    }

    // Use the SDK's native writeFiles method which handles streaming internally,
    // avoiding the command argument size limit that causes "Expected a stream of
    // command data" errors with large files when using runCommand + base64.
    await this.sdk.writeFiles([{ path, content: Buffer.from(content, "utf-8") }]);
  }

  async stat(path: string): Promise<SandboxStats> {
    // Use stat command to get file info
    // Use tab delimiter to avoid issues with file types containing spaces (e.g., "regular file")
    const result = await this.sdk.runCommand({
      cmd: "stat",
      args: ["-c", "%F\t%s\t%Y", path],
      env: this.env,
    });

    if (result.exitCode !== 0) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    const output = (await result.stdout()).trim();
    const [fileType, sizeStr, mtimeStr] = output.split("\t");

    const isDir = fileType === "directory";
    const size = parseInt(sizeStr ?? "0", 10);
    const mtimeMs = parseInt(mtimeStr ?? "0", 10) * 1000;

    return {
      isDirectory: () => isDir,
      isFile: () => !isDir,
      size,
      mtimeMs,
    };
  }

  async access(path: string): Promise<void> {
    const result = await this.sdk.runCommand({
      cmd: "test",
      args: ["-e", path],
      env: this.env,
    });

    if (result.exitCode !== 0) {
      throw new Error(`ENOENT: no such file or directory, access '${path}'`);
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const args = options?.recursive ? ["-p", path] : [path];
    const result = await this.sdk.runCommand({
      cmd: "mkdir",
      args,
      env: this.env,
    });

    if (result.exitCode !== 0) {
      const stderr = await result.stdout(); // stdout contains error in some cases
      if (!stderr.includes("File exists") || !options?.recursive) {
        throw new Error(`Failed to create directory: ${path}`);
      }
    }
  }

  async readdir(path: string, _options: { withFileTypes: true }): Promise<Dirent[]> {
    // List files with type info using find
    const result = await this.sdk.runCommand({
      cmd: "bash",
      args: ["-c", `find "${path}" -maxdepth 1 -mindepth 1 -printf "%y %f\\n"`],
      env: this.env,
    });

    if (result.exitCode !== 0) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    const output = (await result.stdout()).trim();
    if (!output) {
      return [];
    }

    const entries: Dirent[] = output.split("\n").map((line) => {
      const [type, ...nameParts] = line.split(" ");
      const name = nameParts.join(" ");
      const isDir = type === "d";
      const isFile = type === "f";
      const isSymlink = type === "l";

      // Create a Dirent-like object
      return {
        name,
        parentPath: path,
        path: path,
        isDirectory: () => isDir,
        isFile: () => isFile,
        isSymbolicLink: () => isSymlink,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      } as Dirent;
    });

    return entries;
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options?.signal
        ? AbortSignal.any([timeoutSignal, options.signal])
        : timeoutSignal;

      const result = await this.sdk.runCommand({
        cmd: "bash",
        args: ["-c", `cd "${cwd}" && ${command}`],
        env: this.getCommandEnv(),
        signal,
      });

      const [rawStdout, rawStderr] = await Promise.all([result.stdout(), result.stderr()]);
      const stdout = truncateCommandOutput(rawStdout);
      const stderr = truncateCommandOutput(rawStderr);

      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: stdout.output,
        stderr: stderr.output,
        truncated: stdout.truncated || stderr.truncated,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return {
          success: false,
          exitCode: null,
          stdout: "",
          stderr: `Command timed out after ${timeoutMs}ms`,
          truncated: false,
        };
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
      };
    }
  }

  /**
   * Execute a command in detached mode (returns immediately).
   * The command continues running in the background.
   */
  async execDetached(command: string, cwd: string): Promise<{ commandId: string }> {
    const result = await this.sdk.runCommand({
      cmd: "bash",
      args: ["-c", `cd "${cwd}" && ${command}`],
      env: this.getCommandEnv(),
      detached: true,
    });

    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutId = setTimeout(() => {
        abortController.abort();
        resolve({ kind: "timeout" });
      }, DETACHED_QUICK_FAILURE_WINDOW_MS);
    });

    const waitResult = result
      .wait({ signal: abortController.signal })
      .then((finished) => ({ kind: "finished", finished }) as const)
      .catch((error: unknown) => ({ kind: "error", error }) as const);

    const quickProbe = await Promise.race([waitResult, timeoutResult]);

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (quickProbe.kind === "timeout") {
      return { commandId: result.cmdId };
    }

    if (quickProbe.kind === "error") {
      throw quickProbe.error;
    }

    if (quickProbe.finished.exitCode !== 0) {
      const stderr = await quickProbe.finished.stderr();
      const trimmedStderr = stderr.trim();
      const stderrSnippet = trimmedStderr
        ? trimmedStderr.slice(0, MAX_OUTPUT_LENGTH)
        : "<no stderr>";
      throw new Error(
        `Background command exited with code ${quickProbe.finished.exitCode}. stderr:\n${stderrSnippet}`,
      );
    }

    return { commandId: result.cmdId };
  }

  /**
   * Get the public URL for an exposed port.
   */
  domain(port: number): string {
    return this.sdk.domain(port);
  }

  async setGitHubAuthToken(token?: string): Promise<void> {
    await syncGitHubCredentialBrokering(this.sdk, token);
  }

  /**
   * Create a native Vercel snapshot of the sandbox filesystem.
   * IMPORTANT: This automatically stops the sandbox after snapshot creation.
   */
  async snapshot(): Promise<SnapshotResult> {
    const snapshot = await this.sdk.snapshot();

    // Mark sandbox as stopped since native snapshot stops it automatically
    this.isStopped = true;
    this._expiresAt = undefined;

    // Clear proactive timeout timer
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }

    return {
      snapshotId: snapshot.snapshotId,
    };
  }

  /**
   * Stop and clean up the sandbox.
   * Calls beforeStop hook if provided before stopping the sandbox.
   * This method is idempotent - calling it multiple times is safe.
   */
  async stop(): Promise<void> {
    // Ensure stop() only runs once
    if (this.isStopped) return;
    this.isStopped = true;
    this._expiresAt = undefined;

    // Clear proactive timeout timer
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }

    // Run beforeStop hook
    if (this.hooks?.beforeStop) {
      try {
        await this.hooks.beforeStop(this);
      } catch (error) {
        console.error(
          "[VercelSandbox] beforeStop hook failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    await this.sdk.stop();
  }

  /**
   * Get the current status of the sandbox.
   */
  get status(): SandboxStatus {
    this.refreshStateFromCurrentSession();
    if (this.isStopped) return "stopped";
    return "ready";
  }

  /**
   * Get the current state for persistence.
   * Returns state that can be passed to `connectSandbox()` to restore this sandbox.
   */
  getState(): { type: "vercel" } & VercelState {
    this.refreshStateFromCurrentSession();
    return {
      type: "vercel",
      sandboxName: this.name,
      ...(this.expiresAt !== undefined ? { expiresAt: this.expiresAt } : {}),
    };
  }
}

export async function connectVercelSandbox(
  config: VercelSandboxConfig | VercelSandboxConnectConfig = {},
): Promise<VercelSandbox> {
  if ("sandboxName" in config) {
    return VercelSandbox.connect(config.sandboxName, {
      env: config.env,
      githubToken: config.githubToken,
      hooks: config.hooks,
      remainingTimeout: config.remainingTimeout,
      ports: config.ports,
      resume: config.resume,
      signal: config.signal,
    });
  }

  return VercelSandbox.create(config);
}
