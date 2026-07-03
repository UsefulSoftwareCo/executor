import { Sandbox as VercelSandboxSDK, type NetworkPolicy } from "@vercel/sandbox";
import type { VercelSandboxConfig, VercelSandboxSetupEvent } from "./config";

export const DEFAULT_WORKING_DIRECTORY = "/vercel/sandbox";
export const TIMEOUT_BUFFER_MS = 30_000;
const MAX_SDK_TIMEOUT_MS = 18_000_000;
const MAX_PROACTIVE_TIMEOUT_MS = MAX_SDK_TIMEOUT_MS - TIMEOUT_BUFFER_MS;
const GIT_CLONE_TIMEOUT_MS = 180_000;
const DEFAULT_NETWORK_POLICY: NetworkPolicy = "allow-all";

type SetupEventHandler = NonNullable<VercelSandboxConfig["onSetupEvent"]>;
type VercelSandboxGitSource = NonNullable<VercelSandboxConfig["sources"]>[number];
export type VercelSandboxSDKInstance = InstanceType<typeof VercelSandboxSDK>;
export type VercelSandboxSession = ReturnType<VercelSandboxSDKInstance["currentSession"]>;

export type PreparedVercelSandboxSetup = {
  sdk: VercelSandboxSDKInstance;
  session: VercelSandboxSession;
  workingDirectory: string;
  currentBranch?: string;
  effectiveTimeout: number;
  startTime: number;
};

export async function emitSetupEvent(
  onSetupEvent: SetupEventHandler | undefined,
  event: VercelSandboxSetupEvent,
): Promise<void> {
  if (!onSetupEvent) {
    return;
  }

  await onSetupEvent(event);
}

function buildGitHubCredentialBrokeringPolicy(token?: string): NetworkPolicy {
  if (!token) {
    return DEFAULT_NETWORK_POLICY;
  }

  const basicAuthToken = Buffer.from(`x-access-token:${token}`, "utf-8").toString("base64");

  return {
    allow: {
      "api.github.com": [
        {
          transform: [{ headers: { Authorization: `Bearer ${token}` } }],
        },
      ],
      "uploads.github.com": [
        {
          transform: [{ headers: { Authorization: `Bearer ${token}` } }],
        },
      ],
      "codeload.github.com": [
        {
          transform: [{ headers: { Authorization: `Bearer ${token}` } }],
        },
      ],
      "github.com": [
        {
          transform: [{ headers: { Authorization: `Basic ${basicAuthToken}` } }],
        },
      ],
      "*": [],
    },
  };
}

function buildGitCloneEnv(token?: string): Record<string, string> {
  if (!token) {
    return {
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
    };
  }

  const basicAuthToken = Buffer.from(`x-access-token:${token}`, "utf-8").toString("base64");

  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${basicAuthToken}`,
  };
}

function buildSetupCommandSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export async function syncGitHubCredentialBrokering(
  sdk: VercelSandboxSDKInstance,
  token?: string,
  signal?: AbortSignal,
): Promise<void> {
  await sdk.update(
    {
      networkPolicy: buildGitHubCredentialBrokeringPolicy(token),
    },
    signal ? { signal } : undefined,
  );
}

async function clearGitHubCredentialBrokering(
  sdk: VercelSandboxSDKInstance,
  signal?: AbortSignal,
): Promise<void> {
  await syncGitHubCredentialBrokering(sdk, undefined, signal);
}

async function clearGitHubCredentialBrokeringBestEffort(
  sdk: VercelSandboxSDKInstance,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await clearGitHubCredentialBrokering(sdk, signal);
  } catch (error) {
    console.warn("[VercelSandbox] failed to clear GitHub setup auth:", error);
  }
}

function inferRepositoryDirectory(url: string): string | undefined {
  const normalized = url.trim().replace(/\/+$/, "");
  const lastSegment = normalized.slice(normalized.lastIndexOf("/") + 1);
  const directory = lastSegment.replace(/\.git$/i, "");
  return directory.length > 0 ? directory : undefined;
}

function normalizeWorkspaceDirectory(source: VercelSandboxGitSource, index: number): string {
  const directory = (
    source.directory?.trim() ||
    inferRepositoryDirectory(source.url) ||
    `repo-${index + 1}`
  ).replace(/\/+$/, "");

  if (
    directory.length === 0 ||
    directory.startsWith("/") ||
    directory.split("/").includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(directory)
  ) {
    throw new Error(`Invalid source directory '${directory}'`);
  }

  return directory;
}

async function configureGitUser(
  sdk: VercelSandboxSDKInstance,
  cwd: string,
  gitUser: NonNullable<VercelSandboxConfig["gitUser"]>,
  signal?: AbortSignal,
): Promise<void> {
  await sdk.runCommand({
    cmd: "git",
    args: ["config", "user.name", gitUser.name],
    cwd,
    ...(signal ? { signal } : {}),
  });
  await sdk.runCommand({
    cmd: "git",
    args: ["config", "user.email", gitUser.email],
    cwd,
    ...(signal ? { signal } : {}),
  });
}

async function cloneSourceIntoDirectory(params: {
  sdk: VercelSandboxSDKInstance;
  source: VercelSandboxGitSource;
  workingDirectory: string;
  directory: string;
  githubToken?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const cloneArgs = ["clone", "--depth", "1", "--single-branch"];
  if (params.source.branch) {
    cloneArgs.push("--branch", params.source.branch);
  }
  cloneArgs.push(params.source.url, params.directory);

  const cloneResult = await params.sdk.runCommand({
    cmd: "git",
    args: cloneArgs,
    cwd: params.workingDirectory,
    env: buildGitCloneEnv(params.githubToken),
    signal: buildSetupCommandSignal(params.signal, GIT_CLONE_TIMEOUT_MS),
  });

  if (cloneResult.exitCode !== 0) {
    const stderr = await cloneResult.stderr();
    throw new Error(
      `Failed to clone repository '${params.source.url}' into '${params.directory}' (exit code ${cloneResult.exitCode}): ${stderr.trim()}`,
    );
  }
}

export async function prepareVercelSandboxSetup(
  config: VercelSandboxConfig = {},
): Promise<PreparedVercelSandboxSetup> {
  const {
    signal,
    onSetupEvent,
    name,
    source,
    sources = [],
    restoreSnapshotId,
    gitUser,
    githubToken,
    vcpus = 4,
    timeout = 300_000,
    runtime = "node22",
    ports,
    baseSnapshotId,
    persistent = true,
    snapshotExpiration,
    skipGitWorkspaceBootstrap = false,
  } = config;

  if (source && sources.length > 0) {
    throw new Error("Use either source or sources, not both");
  }

  const effectiveTimeout = Math.min(timeout, MAX_PROACTIVE_TIMEOUT_MS);
  if (effectiveTimeout !== timeout) {
    console.warn(
      `[VercelSandbox] Requested timeout ${timeout}ms exceeds max supported proactive timeout ${MAX_PROACTIVE_TIMEOUT_MS}ms; clamping.`,
    );
  }

  const sdkTimeout = effectiveTimeout + TIMEOUT_BUFFER_MS;
  const createBaseConfig = {
    ...(name ? { name } : {}),
    resources: { vcpus },
    timeout: sdkTimeout,
    persistent,
    networkPolicy: buildGitHubCredentialBrokeringPolicy(githubToken),
    ...(signal ? { signal } : {}),
    ...(ports && { ports }),
    ...(snapshotExpiration !== undefined && { snapshotExpiration }),
  };
  const createRuntimeConfig = {
    ...createBaseConfig,
    runtime,
  };

  await emitSetupEvent(onSetupEvent, {
    phase: "sdk-create-start",
    ...(name ? { sandboxName: name } : {}),
    runtime,
    ...(baseSnapshotId ? { baseSnapshotId } : {}),
    ...(restoreSnapshotId ? { restoreSnapshotId } : {}),
  });

  let sdk: VercelSandboxSDKInstance;
  if (restoreSnapshotId) {
    sdk = await VercelSandboxSDK.create({
      ...createBaseConfig,
      source: { type: "snapshot", snapshotId: restoreSnapshotId },
    });
  } else if (baseSnapshotId) {
    sdk = await VercelSandboxSDK.create({
      ...createBaseConfig,
      source: { type: "snapshot", snapshotId: baseSnapshotId },
    });
  } else {
    sdk = await VercelSandboxSDK.create(createRuntimeConfig);
  }

  let githubAuthClearStarted = false;
  let githubAuthCleared = false;
  try {
    await emitSetupEvent(onSetupEvent, {
      phase: "sdk-create-complete",
      sandboxName: sdk.name,
      runtime,
      ...(baseSnapshotId ? { baseSnapshotId } : {}),
      ...(restoreSnapshotId ? { restoreSnapshotId } : {}),
    });

    const workingDirectory = DEFAULT_WORKING_DIRECTORY;
    const clonedSourceDirectories: string[] = [];

    if (source) {
      await emitSetupEvent(onSetupEvent, {
        phase: "clone-source-start",
        sandboxName: sdk.name,
        sourceUrl: source.url,
        ...(source.branch ? { branch: source.branch } : {}),
      });
      const cloneArgs = ["clone", "--depth", "1", "--single-branch"];
      if (source.branch) {
        cloneArgs.push("--branch", source.branch);
      }
      cloneArgs.push(source.url, ".");

      const cloneResult = await sdk.runCommand({
        cmd: "git",
        args: cloneArgs,
        cwd: workingDirectory,
        env: buildGitCloneEnv(githubToken),
        signal: buildSetupCommandSignal(signal, GIT_CLONE_TIMEOUT_MS),
      });

      if (cloneResult.exitCode !== 0) {
        const stderr = await cloneResult.stderr();
        throw new Error(
          `Failed to clone repository '${source.url}' (exit code ${cloneResult.exitCode}): ${stderr.trim()}`,
        );
      }
      await emitSetupEvent(onSetupEvent, {
        phase: "clone-source-complete",
        sandboxName: sdk.name,
        sourceUrl: source.url,
        ...(source.branch ? { branch: source.branch } : {}),
      });
    }

    for (const [index, sourceConfig] of sources.entries()) {
      const directory = normalizeWorkspaceDirectory(sourceConfig, index);
      await emitSetupEvent(onSetupEvent, {
        phase: "clone-workspace-source-start",
        sandboxName: sdk.name,
        sourceUrl: sourceConfig.url,
        directory,
        ...(sourceConfig.branch ? { branch: sourceConfig.branch } : {}),
      });
      await cloneSourceIntoDirectory({
        sdk,
        source: sourceConfig,
        workingDirectory,
        directory,
        githubToken,
        signal,
      });
      clonedSourceDirectories.push(directory);
      await emitSetupEvent(onSetupEvent, {
        phase: "clone-workspace-source-complete",
        sandboxName: sdk.name,
        sourceUrl: sourceConfig.url,
        directory,
        ...(sourceConfig.branch ? { branch: sourceConfig.branch } : {}),
      });
    }

    if (!source && sources.length === 0 && !restoreSnapshotId && !skipGitWorkspaceBootstrap) {
      await emitSetupEvent(onSetupEvent, {
        phase: "git-bootstrap-start",
        sandboxName: sdk.name,
      });
      await sdk.runCommand({
        cmd: "git",
        args: ["init"],
        cwd: workingDirectory,
        ...(signal ? { signal } : {}),
      });
      await emitSetupEvent(onSetupEvent, {
        phase: "git-bootstrap-complete",
        sandboxName: sdk.name,
      });
    }

    if (gitUser && (source || (!skipGitWorkspaceBootstrap && sources.length === 0))) {
      await emitSetupEvent(onSetupEvent, {
        phase: "git-user-start",
        sandboxName: sdk.name,
      });
      await configureGitUser(sdk, workingDirectory, gitUser, signal);
      await emitSetupEvent(onSetupEvent, {
        phase: "git-user-complete",
        sandboxName: sdk.name,
      });
    }

    if (gitUser) {
      for (const directory of clonedSourceDirectories) {
        await emitSetupEvent(onSetupEvent, {
          phase: "git-user-start",
          sandboxName: sdk.name,
          directory,
        });
        await configureGitUser(sdk, `${workingDirectory}/${directory}`, gitUser, signal);
        await emitSetupEvent(onSetupEvent, {
          phase: "git-user-complete",
          sandboxName: sdk.name,
          directory,
        });
      }
    }

    if (
      !source &&
      sources.length === 0 &&
      !restoreSnapshotId &&
      gitUser &&
      !skipGitWorkspaceBootstrap
    ) {
      await emitSetupEvent(onSetupEvent, {
        phase: "git-bootstrap-start",
        sandboxName: sdk.name,
      });
      await sdk.runCommand({
        cmd: "git",
        args: ["commit", "--allow-empty", "-m", "Initial commit"],
        cwd: workingDirectory,
        ...(signal ? { signal } : {}),
      });
      await emitSetupEvent(onSetupEvent, {
        phase: "git-bootstrap-complete",
        sandboxName: sdk.name,
      });
    }

    let currentBranch: string | undefined;
    if (source?.newBranch) {
      await emitSetupEvent(onSetupEvent, {
        phase: "branch-checkout-start",
        sandboxName: sdk.name,
        branch: source.newBranch,
      });
      const checkoutResult = await sdk.runCommand({
        cmd: "git",
        args: ["checkout", "-b", source.newBranch],
        cwd: workingDirectory,
        ...(signal ? { signal } : {}),
      });

      if (checkoutResult.exitCode !== 0) {
        throw new Error(
          `Failed to create branch '${source.newBranch}': ${await checkoutResult.stderr()}`,
        );
      }

      currentBranch = source.newBranch;
      await emitSetupEvent(onSetupEvent, {
        phase: "branch-checkout-complete",
        sandboxName: sdk.name,
        branch: source.newBranch,
      });
    } else if (source?.branch) {
      currentBranch = source.branch;
    }

    for (const [index, sourceConfig] of sources.entries()) {
      if (!sourceConfig.newBranch) {
        continue;
      }
      const directory =
        clonedSourceDirectories[index] ?? normalizeWorkspaceDirectory(sourceConfig, index);
      await emitSetupEvent(onSetupEvent, {
        phase: "branch-checkout-start",
        sandboxName: sdk.name,
        directory,
        branch: sourceConfig.newBranch,
      });
      const checkoutResult = await sdk.runCommand({
        cmd: "git",
        args: ["checkout", "-b", sourceConfig.newBranch],
        cwd: `${workingDirectory}/${directory}`,
        ...(signal ? { signal } : {}),
      });

      if (checkoutResult.exitCode !== 0) {
        throw new Error(
          `Failed to create branch '${sourceConfig.newBranch}' in '${directory}': ${await checkoutResult.stderr()}`,
        );
      }
      await emitSetupEvent(onSetupEvent, {
        phase: "branch-checkout-complete",
        sandboxName: sdk.name,
        directory,
        branch: sourceConfig.newBranch,
      });
    }

    if (githubToken) {
      githubAuthClearStarted = true;
      await emitSetupEvent(onSetupEvent, {
        phase: "github-auth-clear-start",
        sandboxName: sdk.name,
      });
      await clearGitHubCredentialBrokering(sdk, signal);
      githubAuthCleared = true;
      await emitSetupEvent(onSetupEvent, {
        phase: "github-auth-clear-complete",
        sandboxName: sdk.name,
      });
    }

    const startTime = Date.now();
    const session = sdk.currentSession();

    return {
      sdk,
      session,
      workingDirectory,
      currentBranch,
      effectiveTimeout,
      startTime,
    };
  } catch (error) {
    if (githubToken && !githubAuthCleared && !githubAuthClearStarted) {
      await clearGitHubCredentialBrokeringBestEffort(sdk, signal);
    }
    throw error;
  }
}
