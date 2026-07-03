import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { auth } from "@/lib/auth/config";

const execFileAsync = promisify(execFile);
const GH_CLI_AUTH_MODE = "gh-cli";
const GLOBAL_GITHUB_TOKEN_ENV = "OPEN_AGENTS_GITHUB_TOKEN";

export function isGhCliAuthEnabled(): boolean {
  return process.env.OPEN_AGENTS_GITHUB_AUTH_MODE === GH_CLI_AUTH_MODE;
}

export function getGlobalGitHubToken(): string | null {
  const token = process.env[GLOBAL_GITHUB_TOKEN_ENV]?.trim();
  return token ? token : null;
}

export function isGlobalGitHubTokenEnabled(): boolean {
  return getGlobalGitHubToken() !== null;
}

async function getFallbackGitHubToken(): Promise<string | null> {
  return getGlobalGitHubToken() ?? (await getGhCliToken());
}

export async function getGhCliToken(): Promise<string | null> {
  if (!isGhCliAuthEnabled()) {
    return null;
  }

  const ghPath = process.env.GH_CLI_PATH ?? "gh";
  try {
    const { stdout } = await execFileAsync(ghPath, ["auth", "token"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    console.error("Failed to read GitHub token from gh CLI:", error);
    return null;
  }
}

/**
 * Get a valid GitHub access token for the given user.
 * better-auth auto-refreshes expired tokens via stored refresh token.
 */
export async function getUserGitHubToken(
  userId: string,
): Promise<string | null> {
  try {
    const result = await auth.api.getAccessToken({
      body: { providerId: "github", userId },
    });

    return result?.accessToken ?? (await getFallbackGitHubToken());
  } catch (error) {
    // "Account not found" is expected when the user hasn't linked GitHub —
    // only log unexpected errors.
    const isExpected =
      error instanceof Error && error.message === "Account not found";
    if (!isExpected) {
      console.error("Error fetching GitHub token:", error);
    }
    return getFallbackGitHubToken();
  }
}

export async function getGitHubAppUserToken(
  userId: string,
): Promise<string | null> {
  return getUserGitHubToken(userId);
}
