// scenario(): the one way a test is written. The body is an Effect whose
// requirements ARE its capability declaration: it yields services (src/
// services.ts) and nothing else — no needs list. The target provides what it
// has; yielding a service the target lacks surfaces as Effect's own
// missing-service defect, which the runner classifies into a vitest skip
// with the missing service named in the matrix. Convention: yield services
// at the top of the body, so a skip happens before any real work.
// Correctness lives in the test code and its vitest assertions — there is no
// recording layer. What survives per run is a small result.json (for the
// scenario × target matrix) plus whatever artifacts the surfaces produced
// (browser video/trace/screenshots, terminal casts).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { it } from "@effect/vitest";
import { Cause, Context, Effect } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

import type { Target as TargetShape } from "./target";
import { resolveTarget } from "../targets/registry";
import { makeApiSurface } from "./surfaces/api";
import { makeAutumnSurface } from "./surfaces/autumn";
import { makeBrowserSurface } from "./surfaces/browser";
import { makeCliSurface } from "./surfaces/cli";
import { makeMcpSurface } from "./surfaces/mcp";
import { makeTelemetrySurface } from "./surfaces/telemetry";
import { completeOAuthConsent, hasOpenCode, makeOpenCodeHome, warmUp } from "./clients/opencode";
import {
  Api,
  Autumn,
  Billing,
  Browser,
  Cli,
  Mcp,
  OpenCode,
  Restart,
  RunDir,
  Target,
  Telemetry,
  TtlControl,
} from "./services";
import { buildManifest } from "./viewer/manifest";

export const RUNS_DIR = fileURLToPath(new URL("../runs/", import.meta.url));

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

export interface ScenarioOptions {
  readonly timeout?: number;
}

type AllServices =
  | Target
  | RunDir
  | Cli
  | Api
  | Browser
  | Mcp
  | Billing
  | Autumn
  | OpenCode
  | TtlControl
  | Restart
  | Telemetry;

/**
 * What this target on this host can provide. Services beyond the base are
 * conditional, so the claimed type is the full union — yielding an absent
 * one fails with Effect's missing-service defect, which the runner turns
 * into the skip.
 */
const contextFor = (target: TargetShape, dir: string): Context.Context<AllServices> => {
  let context = Context.empty().pipe(
    Context.add(Target, target),
    Context.add(RunDir, dir),
    Context.add(Cli, makeCliSurface()),
  ) as Context.Context<AllServices>;
  const has = target.capabilities.has.bind(target.capabilities);
  if (has("api")) context = Context.add(context, Api, makeApiSurface(target));
  if (has("browser")) context = Context.add(context, Browser, makeBrowserSurface(dir, target));
  if (has("mcp-oauth")) context = Context.add(context, Mcp, makeMcpSurface(target, dir));
  if (has("billing")) context = Context.add(context, Billing, true);
  if (hasOpenCode()) {
    context = Context.add(context, OpenCode, {
      makeHome: makeOpenCodeHome,
      warmUp,
      completeOAuthConsent,
    });
  }
  if (target.setAccessTokenTtl) {
    context = Context.add(context, TtlControl, target.setAccessTokenTtl);
  }
  if (target.restart) {
    context = Context.add(context, Restart, target.restart);
  }
  if (process.env.E2E_MOTEL_URL) {
    context = Context.add(context, Telemetry, makeTelemetrySurface(process.env.E2E_MOTEL_URL));
  }
  if (process.env.E2E_AUTUMN_URL) {
    context = Context.add(context, Autumn, makeAutumnSurface(process.env.E2E_AUTUMN_URL));
  }
  return context;
};

export const scenario = (
  name: string,
  options: ScenarioOptions,
  body: Effect.Effect<void, unknown, AllServices | HttpClient.HttpClient>,
): void => {
  const target = resolveTarget();
  const dir = join(RUNS_DIR, target.name, slugify(name));
  const context = contextFor(target, dir);
  const testFile = captureTestFile();

  it.live(
    name,
    (testCtx) =>
      Effect.gen(function* () {
        // A run's directory is the run — never mix artifacts across attempts.
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const startedAt = Date.now();
        const exit = yield* Effect.exit(
          body.pipe(Effect.provideContext(context)) as Effect.Effect<
            void,
            unknown,
            HttpClient.HttpClient
          >,
        );
        const endedAt = Date.now();

        // Yielding a service this target can't provide is the skip signal.
        const missing = exit._tag === "Failure" ? missingServices(exit.cause) : [];
        if (missing.length > 0) {
          rmSync(dir, { recursive: true, force: true });
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, "skipped.json"),
            JSON.stringify({ scenario: name, target: target.name, missing }, null, 1),
          );
          buildManifest(RUNS_DIR);
          return yield* Effect.sync(() =>
            testCtx.skip(`needs ${missing.join(", ")} — not on ${target.name}`),
          );
        }

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
        // A run with both recordings is ONE developer session — splice them
        // into film.mp4 (scripts/film.ts cuts on the focus timeline) so the
        // viewer plays a single recording, not parts. Best-effort: missing
        // agg/ffmpeg or a film failure never fails the run; the parts stay
        // and the viewer falls back to cast + video in story order.
        if (
          exit._tag === "Success" &&
          existsSync(join(dir, "terminal.cast")) &&
          existsSync(join(dir, "session.mp4"))
        ) {
          yield* Effect.sync(() => {
            // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: optional post-processing over external tooling (agg, ffmpeg)
            try {
              execFileSync(
                "bun",
                [fileURLToPath(new URL("../scripts/film.ts", import.meta.url)), dir],
                { stdio: "pipe", timeout: 120_000 },
              );
            } catch {
              // parts remain the artifacts
            }
          });
        }
        buildManifest(RUNS_DIR);
        if (exit._tag === "Failure") {
          return yield* Effect.failCause(exit.cause);
        }
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    options.timeout ?? 120_000,
  );
};

/** Service keys (sans the e2e/ prefix) whose absence caused this failure. */
const missingServices = (cause: Cause.Cause<unknown>): ReadonlyArray<string> => {
  const rendered = String(Cause.squash(cause));
  return [...rendered.matchAll(/Service not found: e2e\/([^\s(]+)/g)]
    .map((match) => match[1] ?? "")
    .filter((name, index, all) => name !== "" && all.indexOf(name) === index);
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
      blocks.push({
        start: index,
        end,
        mine: source.slice(index, end).includes(`"${name}"`),
      });
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
