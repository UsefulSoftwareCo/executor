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
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { it } from "@effect/vitest";
import { Cause, Context, Effect } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

import type { Target as TargetShape } from "./target";
import { resolveTarget } from "../targets/registry";
import { makeApiSurface } from "./surfaces/api";
import { makeBrowserSurface } from "./surfaces/browser";
import { makeCliSurface } from "./surfaces/cli";
import { makeMcpSurface } from "./surfaces/mcp";
import { makeTelemetrySurface } from "./surfaces/telemetry";
import {
  hasClaudeCode,
  makeClaudeCodeHome,
  removeClaudeCodeHome,
  replaceClaudeCodeServer,
  runClaudeCode,
} from "./clients/claude-code";
import { completeOAuthConsent, hasOpenCode, makeOpenCodeHome, warmUp } from "./clients/opencode";
import { evidenceReferenceFor, writeJsonAtomicSync } from "./artifact-io";
import { writeRunLaneProvenance } from "./evidence-provenance";
import { currentProjectPolicy, isCapabilityRequired } from "./project-matrix";
import { exportPortableTraces } from "./portable-traces";
import {
  Api,
  Billing,
  Browser,
  ClaudeCode,
  Cli,
  Mcp,
  OpenCode,
  Restart,
  RunDir,
  Target,
  Telemetry,
  TtlControl,
} from "./services";
import { writeFocusedTestSource } from "./test-source";
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
  | OpenCode
  | ClaudeCode
  | TtlControl
  | Restart
  | Telemetry;

/**
 * What this target on this host can provide. Services beyond the base are
 * conditional, so the claimed type is the full union — yielding an absent
 * one fails with Effect's missing-service defect, which the runner turns
 * into the skip.
 */
const contextFor = (target: TargetShape, dir: string) => {
  let mcpSurface: ReturnType<typeof makeMcpSurface> | undefined;
  let context = Context.empty().pipe(
    Context.add(Target, target),
    Context.add(RunDir, dir),
    Context.add(Cli, makeCliSurface()),
  ) as Context.Context<AllServices>;
  const has = target.capabilities.has.bind(target.capabilities);
  if (has("api")) context = Context.add(context, Api, makeApiSurface(target));
  if (has("browser")) context = Context.add(context, Browser, makeBrowserSurface(dir, target));
  if (has("mcp-oauth")) {
    mcpSurface = makeMcpSurface(target, dir);
    context = Context.add(context, Mcp, mcpSurface);
  }
  if (has("billing")) context = Context.add(context, Billing, true);
  if (hasOpenCode()) {
    context = Context.add(context, OpenCode, {
      makeHome: makeOpenCodeHome,
      warmUp,
      completeOAuthConsent,
    });
  }
  if (hasClaudeCode()) {
    context = Context.add(context, ClaudeCode, {
      makeHome: makeClaudeCodeHome,
      run: runClaudeCode,
      replaceServer: replaceClaudeCodeServer,
      removeHome: removeClaudeCodeHome,
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
  return {
    context,
    cleanup: mcpSurface?.close() ?? Effect.void,
  };
};

export const scenario = (
  name: string,
  options: ScenarioOptions,
  body: Effect.Effect<void, unknown, AllServices | HttpClient.HttpClient>,
): void => {
  const target = resolveTarget();
  const slug = slugify(name);
  const testFile = captureTestFile();

  it.live(
    name,
    (testCtx) =>
      Effect.gen(function* () {
        const attemptId = randomUUID();
        const dir = join(RUNS_DIR, target.name, `${slug}--${attemptId}`);
        mkdirSync(dir, { recursive: true });
        const laneProvenance = writeRunLaneProvenance(dir, target.name);
        const evidence = evidenceReferenceFor(dir, attemptId);
        const { context, cleanup } = contextFor(target, dir);
        const startedAt = Date.now();
        const exit = yield* Effect.exit(
          (
            body.pipe(Effect.provideContext(context)) as Effect.Effect<
              void,
              unknown,
              HttpClient.HttpClient
            >
          ).pipe(Effect.ensuring(cleanup)),
        );
        const endedAt = Date.now();
        const portableTraces = process.env.E2E_MOTEL_URL
          ? yield* exportPortableTraces(dir, process.env.E2E_MOTEL_URL)
          : undefined;

        // Yielding a service this target can't provide is the skip signal.
        const missing = exit._tag === "Failure" ? missingServices(exit.cause) : [];
        const policy = currentProjectPolicy();
        const requiredMissing = missing.filter((capability) =>
          isCapabilityRequired(policy.projectName, capability),
        );
        if (missing.length > 0 && requiredMissing.length === 0) {
          writeJsonAtomicSync(join(dir, "skipped.json"), {
            scenario: name,
            target: target.name,
            missing,
            ...evidence,
          });
          buildManifest(RUNS_DIR);
          return yield* Effect.sync(() =>
            testCtx.skip(`needs ${missing.join(", ")} — not on ${target.name}`),
          );
        }

        const error = exit._tag === "Failure" ? failureMessage(exit.cause) : undefined;
        const evidenceError =
          portableTraces &&
          isCapabilityRequired(policy.projectName, "telemetry") &&
          (portableTraces.missing > 0 || portableTraces.invalid > 0)
            ? `portable trace export incomplete: ${portableTraces.missing} missing, ${portableTraces.invalid} invalid`
            : undefined;
        // The test source is the review artifact. Ship the named registration
        // with imports and sibling tests removed, plus extraction provenance.
        if (testFile) writeFocusedTestSource({ runDir: dir, filePath: testFile, testName: name });
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
        writeJsonAtomicSync(join(dir, "result.json"), {
          scenario: name,
          target: target.name,
          ok: exit._tag === "Success" && evidenceError === undefined,
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          ...evidence,
          ...(laneProvenance
            ? {
                project: laneProvenance.project,
                visualEvidence: {
                  dataClassification: laneProvenance.dataClassification,
                },
              }
            : {}),
          ...(requiredMissing.length > 0 ? { missingRequiredCapabilities: requiredMissing } : {}),
          ...(portableTraces ? { portableTraces } : {}),
          ...((error ?? evidenceError) ? { error: error ?? evidenceError } : {}),
          artifacts: readdirSync(dir).filter((f) => f !== "result.json"),
        });
        buildManifest(RUNS_DIR);
        if (exit._tag === "Failure") {
          return yield* Effect.failCause(exit.cause);
        }
        if (evidenceError) {
          return yield* Effect.fail({
            _tag: "PortableTraceEvidenceIncomplete",
            message: evidenceError,
          } as const);
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
