// Drive the REAL installed OpenCode binary as an MCP client, hermetically:
// its own XDG dirs, a project dir whose opencode.json points at the target's
// /mcp, and an `open`(1) shim on PATH so the OAuth browser hop becomes a file
// we can read instead of a window. What OpenCode does with discovery, scopes,
// tokens, and refresh is entirely its own code — that is the point.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface OpenCodeHome {
  /** Working directory holding opencode.json (OpenCode reads config from cwd). */
  readonly projectDir: string;
  /** Environment that isolates this OpenCode from the machine's real one. */
  readonly env: Record<string, string>;
  /** Every URL OpenCode tried to open in a browser, in order. */
  readonly openedUrls: () => ReadonlyArray<string>;
  /** OpenCode's own MCP token store (undefined until it persists a grant). */
  readonly storedTokens: (
    serverName: string,
  ) => { accessToken?: string; refreshToken?: string; expiresAt?: number } | undefined;
}

/** A throwaway OpenCode installation configured with one remote MCP server. */
export const makeOpenCodeHome = (serverName: string, mcpUrl: string): OpenCodeHome => {
  const root = mkdtempSync(join(tmpdir(), "e2e-opencode-"));
  const projectDir = join(root, "project");
  const dataDir = join(root, "data");
  const binDir = join(root, "bin");
  const openedUrlsFile = join(root, "opened-urls.txt");
  for (const dir of [projectDir, dataDir, binDir]) mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(projectDir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: { [serverName]: { type: "remote", url: mcpUrl } },
    }),
  );
  // OpenCode launches the OAuth URL via `open`; the shim records it instead.
  writeFileSync(join(binDir, "open"), `#!/bin/sh\necho "$@" >> ${openedUrlsFile}\nexit 0\n`, {
    mode: 0o755,
  });

  return {
    projectDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      XDG_DATA_HOME: dataDir,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
    },
    openedUrls: () =>
      existsSync(openedUrlsFile)
        ? readFileSync(openedUrlsFile, "utf8").split("\n").filter(Boolean)
        : [],
    storedTokens: (name) => {
      const file = join(dataDir, "opencode", "mcp-auth.json");
      if (!existsSync(file)) return undefined;
      const store = JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        { tokens?: { accessToken?: string; refreshToken?: string; expiresAt?: number } }
      >;
      return store[name]?.tokens;
    },
  };
};

/**
 * Play the signed-in human for an OAuth flow OpenCode just started: wait for
 * it to "open the browser" (the shim records the URL instead), then follow
 * the authorize URL with login_hint — the emulator's consent redirects the
 * code straight to OpenCode's localhost callback.
 */
export const completeOAuthConsent = async (
  home: OpenCodeHome,
  email: string,
  sinceIndex: number,
): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const url = home.openedUrls()[sinceIndex];
    if (url) {
      const response = await fetch(`${url}&login_hint=${encodeURIComponent(email)}`);
      if (!response.ok) throw new Error(`consent redirect chain failed (${response.status})`);
      return;
    }
    await new Promise((tick) => setTimeout(tick, 250));
  }
  throw new Error("opencode never opened an authorization URL");
};
