// The Recorder: every surface emits its turns + evidence here, so a watchable
// run.json falls out of every scenario with zero per-test effort. One Recorder
// per scenario execution; it also owns the run's artifact directory (where
// screenshots / videos land) so evidence paths stay relative + self-contained.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Assertion, Evidence, Run, Surface, Turn } from "./schema";
import { slugify } from "./schema";

export class AssertionError extends Error {
  readonly _tag = "E2EAssertionError";
}

export interface Expectation<A> {
  toBe(expected: A): void;
  toContain(expected: unknown): void;
  toMatch(re: RegExp): void;
  toBeGreaterThan(expected: number): void;
  toBeLessThan(expected: number): void;
}

export class Recorder {
  readonly run: Run;
  readonly dir: string;
  #artifactCount = 0;

  constructor(options: {
    readonly scenario: string;
    readonly target: string;
    readonly runsDir: string;
    readonly meta?: Record<string, unknown>;
  }) {
    this.dir = join(options.runsDir, options.target, slugify(options.scenario));
    // A run's directory is the run — stale evidence from a previous attempt
    // must never mix into a fresh transcript.
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.run = {
      schema: 2,
      scenario: options.scenario,
      target: options.target,
      brain: "scripted",
      ok: true,
      startedAt: Date.now(),
      meta: { ...options.meta },
      turns: [],
      asserts: [],
    };
    this.turn({ role: "user", text: options.scenario });
  }

  turn(t: Omit<Turn, "t"> & { t?: number }): void {
    this.run.turns.push({ t: Date.now(), ...t } as Turn);
  }

  say(text: string): void {
    this.turn({ role: "assistant", kind: "reasoning", text });
  }

  auth(
    phase: "connect" | "authorize" | "code" | "connected",
    text: string,
    extra?: { ok?: boolean; detail?: unknown },
  ): void {
    this.turn({ role: "auth", phase, text, ...extra });
  }

  toolCall(options: {
    readonly surface: Surface;
    readonly name: string;
    readonly args: unknown;
    readonly result: unknown;
    readonly ok: boolean;
    readonly text: string;
    readonly durationMs?: number;
    readonly evidence?: ReadonlyArray<Evidence>;
  }): void {
    const { surface, name, args, ...rest } = options;
    this.turn({ role: "tool", surface, call: { name, args }, ...rest });
  }

  step(surface: Surface, text: string, evidence?: ReadonlyArray<Evidence>): void {
    this.turn({ role: "step", surface, text, evidence });
  }

  error(text: string, evidence?: ReadonlyArray<Evidence>): void {
    this.run.ok = false;
    this.turn({ role: "error", text, evidence });
  }

  /** Reserve a file inside the run's artifact dir; returns abs path + the rel path evidence should reference. */
  artifact(name: string): { abs: string; rel: string } {
    const rel = `${String(this.#artifactCount++).padStart(2, "0")}-${name}`;
    return { abs: join(this.dir, rel), rel };
  }

  /** Recorded assertion: lands in the transcript adjacent to its evidence, throws on failure. */
  expect<A>(actual: A, label?: string): Expectation<A> {
    const record = (assertion: Assertion) => {
      this.run.asserts.push(assertion);
      this.turn({ role: "assert", assertion });
      if (!assertion.ok) {
        this.run.ok = false;
        throw new AssertionError(
          `expect(${JSON.stringify(assertion.actual)}).${assertion.kind}(${JSON.stringify(assertion.expected)})${label ? ` — ${label}` : ""}`,
        );
      }
    };
    const check = (kind: string, ok: boolean, expected: unknown) =>
      record({ kind, actual: compact(actual), expected: compact(expected), ok, label });
    return {
      toBe: (e) => check("toBe", Object.is(actual, e), e),
      toContain: (e) =>
        check(
          "toContain",
          Array.isArray(actual) ? actual.includes(e) : String(actual).includes(String(e)),
          e,
        ),
      toMatch: (re) => check("toMatch", re.test(String(actual)), String(re)),
      toBeGreaterThan: (e) => check("toBeGreaterThan", (actual as number) > e, e),
      toBeLessThan: (e) => check("toBeLessThan", (actual as number) < e, e),
    };
  }

  finish(error?: unknown): Run {
    if (error !== undefined && error !== null) {
      const message = error instanceof Error ? error.message : String(error);
      this.run.error = message;
      // AssertionErrors already produced their assert turn; anything else is unexpected.
      if (!(error instanceof AssertionError)) this.error(message);
      this.run.ok = false;
    }
    this.run.endedAt = Date.now();
    this.run.durationMs = this.run.endedAt - this.run.startedAt;
    return this.run;
  }

  write(): void {
    writeFileSync(join(this.dir, "run.json"), JSON.stringify(this.run, null, 1));
  }
}

// Evidence/assert payloads must stay readable in the viewer — clip anything huge.
const compact = (value: unknown): unknown => {
  const json = JSON.stringify(value);
  if (json !== undefined && json.length > 4_000) {
    return `${json.slice(0, 4_000)}… (${json.length} chars)`;
  }
  return value;
};
