// scenario(): the one way a test is written. Picks the target from E2E_TARGET
// (set by the vitest project), skips when the target lacks a needed capability,
// provides a Recorder + the four surface drivers, and — pass or fail — writes
// the watchable run.json + player.html and rebuilds the matrix index. Evidence
// is a side effect of using the surfaces, never a per-test chore.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

import { Recorder } from "./recorder";
import type { Capability, Target } from "./target";
import { slugify } from "./schema";
import { resolveTarget } from "../targets/registry";
import { makeApiSurface, type ApiSurface } from "./surfaces/api";
import { makeBrowserSurface, type BrowserSurface } from "./surfaces/browser";
import { makeCliSurface, type CliSurface } from "./surfaces/cli";
import { makeMcpSurface, type McpSurface } from "./surfaces/mcp";
import { writePlayer } from "./viewer/render";
import { buildIndex } from "./viewer/index-builder";

export const RUNS_DIR = fileURLToPath(new URL("../runs/", import.meta.url));

export interface ScenarioContext {
  readonly target: Target;
  readonly rec: Recorder;
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
  if (missing.length > 0) {
    writeSkipMarker(target, name, missing);
    it.skip(`${name} [needs ${missing.join(", ")} — not on ${target.name}]`, () => {});
    return;
  }

  it.live(
    name,
    () =>
      Effect.gen(function* () {
        const rec = new Recorder({
          scenario: name,
          target: target.name,
          runsDir: RUNS_DIR,
          meta: { baseUrl: target.baseUrl },
        });
        const ctx: ScenarioContext = {
          target,
          rec,
          api: makeApiSurface(rec, target),
          browser: makeBrowserSurface(rec, target),
          cli: makeCliSurface(rec),
          mcp: makeMcpSurface(rec, target),
        };
        const exit = yield* Effect.exit(body(ctx));
        rec.finish(exit._tag === "Failure" ? failureMessage(exit.cause) : undefined);
        rec.write();
        writePlayer(rec.run, rec.dir);
        buildIndex(RUNS_DIR);
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

// Capability-skipped cells still show up in the matrix (as "—"), so the index
// distinguishes "not applicable here" from "never ran".
const writeSkipMarker = (target: Target, name: string, missing: ReadonlyArray<string>): void => {
  const dir = join(RUNS_DIR, target.name, slugify(name));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "skipped.json"),
    JSON.stringify({ scenario: name, target: target.name, missing }, null, 1),
  );
};
