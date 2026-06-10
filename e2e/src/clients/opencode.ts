// Drive the REAL installed OpenCode binary as an MCP client, hermetically:
// its own XDG dirs, a project dir whose opencode.json points at the target's
// /mcp, and an `open`(1) shim on PATH so the OAuth browser hop becomes a file
// we can read instead of a window. What OpenCode does with discovery, scopes,
// tokens, and refresh is entirely its own code — that is the point.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

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

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");
const OSC = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g");
const stripAnsi = (text: string): string =>
  text.replace(CSI, "").replace(OSC, "").replace(/\r/g, "\n");

interface RunResult {
  readonly output: string;
  readonly exitCode: number;
  readonly failure?: string;
}

/** Spawn `opencode <args>`; never rejects — failures are carried in the result. */
const run = (
  home: OpenCodeHome,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn("opencode", args, {
      cwd: home.projectDir,
      env: home.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ output: stripAnsi(output), exitCode: -1, failure: "timed out" });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output: stripAnsi(output), exitCode: code ?? -1 });
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      resolve({ output: stripAnsi(output), exitCode: -1, failure: String(cause) });
    });
  });

const okOrThrow = (label: string, result: RunResult): RunResult => {
  if (result.failure) throw new Error(`${label} ${result.failure}:\n${result.output}`);
  return result;
};

/** Run `opencode <args>` in the hermetic home; resolves with cleaned output. */
export const opencode = (
  home: OpenCodeHome,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs?: number } = {},
): Effect.Effect<{ readonly output: string; readonly exitCode: number }> =>
  Effect.promise(async () =>
    okOrThrow(`opencode ${args.join(" ")}`, await run(home, args, options.timeoutMs ?? 60_000)),
  );

/**
 * `opencode mcp auth <server>` end to end: OpenCode runs its own discovery →
 * DCR → authorize (captured by the open-shim) and waits on its localhost
 * callback; we play the signed-in human by following the authorize URL with
 * login_hint, which lands the code on OpenCode's callback.
 */
export const opencodeAuth = (
  home: OpenCodeHome,
  serverName: string,
  email: string,
): Effect.Effect<{ readonly output: string; readonly exitCode: number }> =>
  Effect.promise(async () => {
    const seen = home.openedUrls().length;
    const auth = run(home, ["mcp", "auth", serverName], 60_000);

    const consent = (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const url = home.openedUrls()[seen];
        if (url) {
          const response = await fetch(`${url}&login_hint=${encodeURIComponent(email)}`);
          if (!response.ok) {
            throw new Error(`consent redirect chain failed (${response.status})`);
          }
          return;
        }
        await new Promise((tick) => setTimeout(tick, 250));
      }
      throw new Error("opencode never opened an authorization URL");
    })();

    const [result] = await Promise.all([auth, consent]);
    return okOrThrow("opencode mcp auth", result);
  });
