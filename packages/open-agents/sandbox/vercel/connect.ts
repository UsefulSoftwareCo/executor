import type { Sandbox, SandboxHooks } from "../interface";
import type { VercelSandboxConfig, VercelSandboxSetupEvent } from "./config";
import { VercelSandbox } from "./sandbox";
import type { VercelState } from "./state";

interface ConnectOptions {
  signal?: AbortSignal;
  onSetupEvent?: (event: VercelSandboxSetupEvent) => void | Promise<void>;
  env?: Record<string, string>;
  githubToken?: string;
  gitUser?: { name: string; email: string };
  hooks?: SandboxHooks;
  timeout?: number;
  vcpus?: number;
  ports?: number[];
  baseSnapshotId?: string;
  resume?: boolean;
  create?: boolean;
  persistent?: boolean;
  snapshotExpiration?: number;
  skipGitWorkspaceBootstrap?: boolean;
}

function getRemainingTimeout(expiresAt: number | undefined): number | undefined {
  if (!expiresAt) {
    return undefined;
  }

  const remaining = expiresAt - Date.now();
  return remaining > 10_000 ? remaining : undefined;
}

function getSandboxName(state: VercelState): string | undefined {
  if (typeof state.sandboxName === "string" && state.sandboxName.length > 0) {
    return state.sandboxName;
  }

  return undefined;
}

function buildCreateConfig(state: VercelState, options?: ConnectOptions): VercelSandboxConfig {
  const sandboxName = getSandboxName(state);

  return {
    ...(sandboxName ? { name: sandboxName } : {}),
    ...(state.source
      ? {
          source: {
            url: state.source.repo,
            branch: state.source.branch,
            newBranch: state.source.newBranch,
          },
        }
      : {}),
    ...(state.sources && state.sources.length > 0
      ? {
          sources: state.sources.map((source) => ({
            url: source.repo,
            branch: source.branch,
            directory: source.directory,
            newBranch: source.newBranch,
          })),
        }
      : {}),
    env: options?.env,
    signal: options?.signal,
    onSetupEvent: options?.onSetupEvent,
    githubToken: options?.githubToken,
    gitUser: options?.gitUser,
    hooks: options?.hooks,
    ...(options?.timeout !== undefined && { timeout: options.timeout }),
    ...(options?.vcpus !== undefined && { vcpus: options.vcpus }),
    ...(options?.ports && { ports: options.ports }),
    ...(options?.baseSnapshotId && {
      baseSnapshotId: options.baseSnapshotId,
    }),
    ...(options?.persistent !== undefined && {
      persistent: options.persistent,
    }),
    ...(options?.snapshotExpiration !== undefined && {
      snapshotExpiration: options.snapshotExpiration,
    }),
    ...(options?.skipGitWorkspaceBootstrap && {
      skipGitWorkspaceBootstrap: true,
    }),
  };
}

function hasCreationSource(state: VercelState): boolean {
  return !!state.source || !!state.sources?.length;
}

async function connectNamedSandbox(state: VercelState, options?: ConnectOptions): Promise<Sandbox> {
  const sandboxName = getSandboxName(state);
  if (!sandboxName) {
    throw new Error("Persistent sandbox name is required");
  }

  const remainingTimeout = getRemainingTimeout(state.expiresAt);

  return VercelSandbox.connect(sandboxName, {
    env: options?.env,
    signal: options?.signal,
    githubToken: options?.githubToken,
    hooks: options?.hooks,
    remainingTimeout,
    ports: options?.ports,
    resume: options?.resume,
  });
}

/**
 * Connect to the Vercel-backed cloud sandbox based on the provided state.
 *
 * - If `sandboxName` is present, reconnects to the named persistent sandbox
 * - If `source` is present, creates a new sandbox and prepares the repo
 * - Otherwise, creates an empty sandbox
 */
export async function connectVercel(
  state: VercelState,
  options?: ConnectOptions,
): Promise<Sandbox> {
  const sandboxName = getSandboxName(state);

  if (sandboxName && !options?.create && !hasCreationSource(state)) {
    return connectNamedSandbox(state, options);
  }

  return VercelSandbox.create(buildCreateConfig(state, options));
}
