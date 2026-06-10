// scenario(): the one way a test is written. Picks the target from E2E_TARGET
// (set by the vitest project), skips when the target lacks a needed capability,
// and provides the surface drivers. Correctness lives in the test code and its
// vitest assertions — there is no recording layer. What survives per run is a
// small result.json (for the scenario × target matrix) plus whatever artifacts
// the browser surface produced (video, screenshots, trace.zip).
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

import type { Capability, Target } from "./target";
import { resolveTarget } from "../targets/registry";
import { makeApiSurface, type ApiSurface } from "./surfaces/api";
import { makeBrowserSurface, type BrowserSurface } from "./surfaces/browser";
import { makeCliSurface, type CliSurface } from "./surfaces/cli";
import { makeMcpSurface, type McpSurface } from "./surfaces/mcp";
import { buildManifest } from "./viewer/manifest";

export const RUNS_DIR = fileURLToPath(new URL("../runs/", import.meta.url));

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

export interface ScenarioContext {
  readonly target: Target;
  /** Artifact directory for this run (browser video/screenshots/trace land here). */
  readonly dir: string;
  readonly api: ApiSurface;
  readonly browser: BrowserSurface;
  readonly cli: CliSurface;
  readonly mcp: McpSurface;
}

export interface ScenarioOptions {
  readonly needs?: ReadonlyArray<Capability>;
  readonly timeout?: number;
}

export const scenario = (
  name: string,
  options: ScenarioOptions,
  body: (ctx: ScenarioContext) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
): void => {
  const target = resolveTarget();
  const missing = (options.needs ?? []).filter((c) => !target.capabilities.has(c));
  const dir = join(RUNS_DIR, target.name, slugify(name));
  const testFile = captureTestFile();

  if (missing.length > 0) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "skipped.json"),
      JSON.stringify({ scenario: name, target: target.name, missing }, null, 1),
    );
    it.skip(`${name} [needs ${missing.join(", ")} — not on ${target.name}]`, () => {});
    return;
  }

  it.live(
    name,
    () =>
      Effect.gen(function* () {
        // A run's directory is the run — never mix artifacts across attempts.
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const startedAt = Date.now();
        const ctx: ScenarioContext = {
          target,
          dir,
          api: makeApiSurface(target),
          browser: makeBrowserSurface(dir, target),
          cli: makeCliSurface(),
          mcp: makeMcpSurface(target),
        };
        const exit = yield* Effect.exit(body(ctx));
        const endedAt = Date.now();
        const error = exit._tag === "Failure" ? failureMessage(exit.cause) : undefined;
        // The test source is the review artifact — ship this scenario's code
        // (imports + sibling scenarios stripped) alongside the run.
        const source = testFile ? extractScenarioSource(testFile, name) : undefined;
        if (source) writeFileSync(join(dir, "test.ts"), source);
        writeFileSync(
          join(dir, "result.json"),
          JSON.stringify(
            {
              scenario: name,
              target: target.name,
              ok: exit._tag === "Success",
              startedAt,
              endedAt,
              durationMs: endedAt - startedAt,
              ...(error ? { error } : {}),
              artifacts: readdirSync(dir).filter((f) => f !== "result.json"),
            },
            null,
            1,
          ),
        );
        buildManifest(RUNS_DIR);
        if (exit._tag === "Failure") {
          return yield* Effect.failCause(exit.cause);
        }
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    options.timeout ?? 120_000,
  );
};

const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const rendered = String(Cause.squash(cause));
  return rendered.length > 2_000 ? `${rendered.slice(0, 2_000)}…` : rendered;
};

/** The *.test.ts file that called scenario(), from the registration stack. */
const captureTestFile = (): string | undefined => {
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n")) {
    const match = /\(?(?:file:\/\/)?(\/[^():]+\.test\.ts)/.exec(line);
    if (match) return match[1];
  }
  return undefined;
};

/**
 * This scenario's code as a reader sees it: the file minus import statements
 * and minus every OTHER scenario() block (module-level helpers stay — they're
 * part of understanding the test). Falls back to undefined on any surprise so
 * a parsing edge case can never fail a run.
 */
const extractScenarioSource = (filePath: string, name: string): string | undefined => {
  try {
    const source = readFileSync(filePath, "utf8").replace(/^import[\s\S]*?;[^\S\n]*$/gm, "");
    const needle = "scenario(";
    const blocks: Array<{ start: number; end: number; mine: boolean }> = [];
    let index = 0;
    while ((index = source.indexOf(needle, index)) !== -1) {
      let depth = 0;
      let end = -1;
      for (let i = index + needle.length - 1; i < source.length; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") {
          depth--;
          if (depth === 0) {
            end = source[i + 1] === ";" ? i + 2 : i + 1;
            break;
          }
        }
      }
      if (end === -1) return undefined; // unbalanced — bail to be safe
      blocks.push({ start: index, end, mine: source.slice(index, end).includes(`"${name}"`) });
      index = end;
    }
    if (!blocks.some((b) => b.mine)) return undefined;
    let out = source;
    for (const block of [...blocks].reverse()) {
      if (!block.mine) out = out.slice(0, block.start) + out.slice(block.end);
    }
    return `${out.replace(/\n{3,}/g, "\n\n").trim()}\n`;
  } catch {
    return undefined;
  }
};
