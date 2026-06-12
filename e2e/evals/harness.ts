// The eval harness: run the REAL OpenCode binary with real Go-subscription
// inference against a real target, then grade the result with deterministic
// checks. One eval = one task × one model × one trial; the vitest file fans
// out the matrix and aggregates pass rates (see report.ts).
//
// Design intent (EVALS.md): the agent gets the user's one-line ask and
// whatever our MCP server advertises — no extra system prompt, no coached
// tool order. The tool descriptions are what's under test.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import type { Identity, Target } from "../src/target";
import { makeOpenCodeHome, warmUp, type OpenCodeHome } from "../src/clients/opencode";

// ---------------------------------------------------------------------------
// Config — every knob is an env var so CI and local runs share one path.
// ---------------------------------------------------------------------------

export const EVAL_DEFAULT_MODELS = [
  // Spread across separate Go quota pools; see EVALS.md for the full table.
  "opencode/deepseek-v4-flash",
  "opencode/minimax-m2.5",
  "opencode/kimi-k2.5",
] as const;

export const evalsEnabled = (): boolean => process.env.EVAL === "1";

export const evalModels = (): readonly string[] =>
  process.env.EVAL_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean) ?? EVAL_DEFAULT_MODELS;

export const evalTrials = (): number => {
  const parsed = Number(process.env.EVAL_TRIALS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
};

/** The host machine's Go credential, copied into each hermetic home so the
 *  throwaway OpenCode can use the subscription. */
const hostAuthFile = (): string => join(homedir(), ".local", "share", "opencode", "auth.json");

export const hasGoSubscription = (): boolean => existsSync(hostAuthFile());

// ---------------------------------------------------------------------------
// One trial: spawn `opencode run` headless, collect the JSON event stream.
// ---------------------------------------------------------------------------

export interface TrialEvent {
  readonly type: string;
  readonly part?: {
    readonly type?: string;
    readonly text?: string;
    readonly tool?: string;
    readonly state?: {
      readonly status?: string;
      readonly input?: unknown;
      readonly output?: unknown;
    };
  };
}

export interface TrialResult {
  /** Every JSON event opencode emitted, in order. */
  readonly events: readonly TrialEvent[];
  /** All assistant text parts joined — "what the user read". */
  readonly answerText: string;
  /** Raw stdout (JSONL) for the artifact dir. */
  readonly rawStdout: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export const trialAnswerText = (events: readonly TrialEvent[]): string =>
  events
    .filter((e) => e.type === "text" && typeof e.part?.text === "string")
    .map((e) => e.part?.text ?? "")
    .join("\n");

/** Tool-call inputs/outputs as strings, for transcript-wide content checks
 *  (e.g. "the credential never appears anywhere the model produced"). */
export const trialToolTraffic = (events: readonly TrialEvent[]): string =>
  events
    .filter((e) => e.type === "tool_use")
    .map((e) => JSON.stringify(e.part?.state ?? {}))
    .join("\n");

/** Names of tools the model invoked, for "used our MCP tools at all" checks. */
export const trialToolNames = (events: readonly TrialEvent[]): readonly string[] =>
  events.filter((e) => e.type === "tool_use").map((e) => e.part?.tool ?? "");

export interface RunTrialOptions {
  readonly serverName: string;
  readonly mcpUrl: string;
  readonly model: string;
  readonly prompt: string;
  /** Identity whose email answers the MCP OAuth consent hop. */
  readonly identity: Identity;
  readonly timeoutMs: number;
}

/** A hermetic OpenCode home wired for real inference: the target's MCP server
 *  plus the host's Go credential. Tool permissions are pre-allowed — evals
 *  measure model behavior, not consent dialogs. */
const makeEvalHome = (serverName: string, mcpUrl: string): OpenCodeHome => {
  const home = makeOpenCodeHome(serverName, mcpUrl);
  const authDir = join(home.env.XDG_DATA_HOME ?? "", "opencode");
  mkdirSync(authDir, { recursive: true });
  copyFileSync(hostAuthFile(), join(authDir, "auth.json"));
  // Extend the generated opencode.json: keep the MCP server, allow all tools,
  // disable share/autoupdate noise.
  const configPath = join(home.projectDir, "opencode.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      share: "disabled",
      permission: { "*": "allow" },
      mcp: { [serverName]: { type: "remote", url: mcpUrl } },
    }),
  );
  return home;
};

/** Play the signed-in human for OpenCode's recorded browser hop: sign in for
 *  a Better Auth session cookie, drive the authorize URL with it, and deliver
 *  the resulting code to OpenCode's localhost callback. (The scenario-side
 *  completeOAuthConsent uses login_hint — that's the cloud emulator's dialect;
 *  selfhost's Better Auth consent requires the cookie.) */
const consentWithCookie = async (
  home: OpenCodeHome,
  identity: Identity,
  baseUrl: string,
  sinceIndex: number,
): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const authorizationUrl = home.openedUrls()[sinceIndex];
    if (authorizationUrl) {
      const cookie = identity.headers?.cookie ?? "";
      const authorize = await fetch(authorizationUrl, {
        headers: { cookie },
        redirect: "manual",
      });
      const location = authorize.headers.get("location");
      if (!location) {
        throw new Error(`eval consent: authorize did not redirect (${authorize.status})`);
      }
      // Hand the code to OpenCode's local callback server.
      const callback = await fetch(location);
      if (!callback.ok) throw new Error(`eval consent: callback failed (${callback.status})`);
      return;
    }
    await new Promise((tick) => setTimeout(tick, 250));
  }
  throw new Error("eval consent: opencode never opened an authorization URL");
};

/** Connect OpenCode to the target's MCP server before the trial — a user's
 *  OpenCode is already authenticated by the time they ask for work, and
 *  `opencode run` does not initiate MCP OAuth itself (without this, the
 *  executor tools simply never exist and the model free-styles with bash). */
const preAuthMcp = async (
  home: OpenCodeHome,
  serverName: string,
  identity: Identity,
  baseUrl: string,
): Promise<void> => {
  // First-run database migration in a bare project — `mcp auth` misbehaves
  // if it doubles as first run (see warmUp's doc comment).
  warmUp(home);
  // The auth command must run ASYNC (spawn, not spawnSync): the consent
  // helper polls on timers, and a blocked event loop would starve it while
  // `mcp auth` sits waiting for the browser hop it recorded via the shim.
  const sinceIndex = home.openedUrls().length;
  const auth = spawn("opencode", ["mcp", "auth", serverName], {
    cwd: home.projectDir,
    env: home.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const authExit = new Promise<void>((resolve) => {
    const killer = setTimeout(() => auth.kill("SIGKILL"), 90_000);
    auth.once("exit", () => {
      clearTimeout(killer);
      resolve();
    });
  });
  await consentWithCookie(home, identity, baseUrl, sinceIndex);
  await authExit;
  const listed = spawnSync("opencode", ["mcp", "list"], {
    cwd: home.projectDir,
    env: home.env,
    timeout: 60_000,
    encoding: "utf8",
  });
  if (!`${listed.stdout}`.includes("connected")) {
    throw new Error(`eval pre-auth: MCP server never reached "connected" for ${serverName}`);
  }
};

export const runTrial = (options: RunTrialOptions): Effect.Effect<TrialResult, Error> =>
  Effect.promise(async () => {
    const home = makeEvalHome(options.serverName, options.mcpUrl);
    const baseUrl = new URL(options.mcpUrl).origin;
    await preAuthMcp(home, options.serverName, options.identity, baseUrl);
    const startedAt = Date.now();

    const child = spawn(
      "opencode",
      ["run", "-m", options.model, "--format", "json", options.prompt],
      {
        cwd: home.projectDir,
        // PWD must match cwd: the inherited value points at the eval RUNNER's
        // checkout, and a leaked path invites the model to wander our repo
        // instead of acting like a user in an empty project.
        env: { ...home.env, PWD: home.projectDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

    // Play the signed-in human whenever OpenCode opens an OAuth consent URL.
    // Pre-auth already granted the MCP session; this loop stays alive for the
    // whole trial in case the agent triggers another browser hop mid-run.
    let consented = home.openedUrls().length;
    const consentLoop = setInterval(() => {
      const urls = home.openedUrls();
      if (urls.length > consented) {
        const index = consented;
        consented = urls.length;
        void consentWithCookie(home, options.identity, baseUrl, index).catch(() => {});
      }
    }, 300);

    const exitCode = await new Promise<number | null>((resolve) => {
      const killer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
      child.once("exit", (code) => {
        clearTimeout(killer);
        resolve(code);
      });
    });
    clearInterval(consentLoop);

    const events: TrialEvent[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-json-parse -- boundary: tolerant parse of opencode's JSONL event stream
      try {
        events.push(JSON.parse(line) as TrialEvent);
      } catch {
        // Non-JSON line (banner, warning) — keep going.
      }
    }

    return {
      events,
      answerText: trialAnswerText(events),
      rawStdout: stdout.length > 0 ? stdout : stderr,
      exitCode,
      durationMs: Date.now() - startedAt,
    };
  });

// ---------------------------------------------------------------------------
// Task registry — a task is a prompt plus deterministic graders.
// ---------------------------------------------------------------------------

export interface GradeContext {
  readonly trial: TrialResult;
  readonly target: Target;
  readonly identity: Identity;
  /** Authenticated fetch against the target's API, for outcome checks. */
  readonly apiGet: (path: string) => Promise<unknown>;
}

export interface GradeCheck {
  readonly name: string;
  readonly pass: boolean;
  readonly detail?: string;
}

export interface EvalTask {
  readonly id: string;
  /** The user's one-line ask — the ONLY prompt the model gets. */
  readonly prompt: (input: { readonly integration: string }) => string;
  readonly timeoutMs: number;
  /** Deterministic checks; the trial passes iff every check passes. */
  readonly grade: (
    ctx: GradeContext,
    input: { readonly integration: string },
  ) => Promise<readonly GradeCheck[]>;
}
