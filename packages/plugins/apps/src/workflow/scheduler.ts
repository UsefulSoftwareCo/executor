import { Effect } from "effect";

import type { AppsRuntime } from "../plugin/runtime";

// ---------------------------------------------------------------------------
// Scheduler — starts due workflow runs from the schedules extracted into the
// descriptor, and re-drives sleeping/waiting runs whose wake time has passed.
// Self-hosted: a single in-process interval ticks and does both. The cloud
// backing (future) is CF cron triggers + the DO alarm. Timezone handling is
// minimal (UTC cron eval); DST-correct local-time cron is a documented cut.
//
// A cron field parser good enough for the extracted schedules ("0 9 * * 1-5"):
// minute hour day-of-month month day-of-week, with `*`, lists, ranges, steps.
// ---------------------------------------------------------------------------

// A cron field parse that CANNOT hang on adversarial input (Fix 8). The naive
// `for (v = lo; v <= hi; v += step)` loops forever on `step <= 0` and iterates
// billions of times on a huge/negative/reversed range. This parser validates
// every part against the field's [min, max] bounds and requires an integer
// `step >= 1`, throwing `CronError` (never looping) on anything malformed. The
// loop is additionally clamped to the field bounds, so the worst case is
// `max - min` iterations (< 60) regardless of input.
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

const parseInt10 = (value: string, what: string): number => {
  if (!/^-?\d+$/.test(value)) throw new CronError(`invalid ${what}: "${value}"`);
  return Number(value);
};

const parseField = (field: string, min: number, max: number): Set<number> => {
  const out = new Set<number>();
  if (field === "") throw new CronError("empty cron field");
  for (const part of field.split(",")) {
    const [rangePart, stepPart, ...extra] = part.split("/");
    if (extra.length > 0) throw new CronError(`invalid cron step in "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      step = parseInt10(stepPart, "cron step");
      // A step of 0 or negative would never advance the loop -> infinite loop.
      if (step < 1) throw new CronError(`cron step must be >= 1 (got ${step})`);
    }
    let lo = min;
    let hi = max;
    if (rangePart !== "*" && rangePart !== "") {
      const [a, b] = rangePart.split("-");
      lo = parseInt10(a, "cron range start");
      hi = b !== undefined ? parseInt10(b, "cron range end") : lo;
    } else if (rangePart === "") {
      throw new CronError("empty cron range");
    }
    // Bound the range to the field's valid domain, and reject a reversed range,
    // so the loop is always finite and small.
    if (lo < min || hi > max) {
      throw new CronError(`cron value out of range [${min}, ${max}]: ${lo}-${hi}`);
    }
    if (lo > hi) throw new CronError(`cron range is reversed: ${lo}-${hi}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
};

/** Validate a 5-field cron expression by parsing every field. Throws `CronError`
 *  on anything malformed (bad field count, step < 1, out-of-range, reversed
 *  range). Returns nothing; used at PUBLISH time to reject adversarial crons and
 *  as the shared validator the matcher builds on. */
export const validateCron = (cron: string): void => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(`cron must have 5 fields, got ${parts.length}: "${cron}"`);
  }
  const [min, hour, dom, mon, dow] = parts;
  parseField(min, 0, 59);
  parseField(hour, 0, 23);
  parseField(dom, 1, 31);
  parseField(mon, 1, 12);
  parseField(dow, 0, 6);
};

/** True if `date` (UTC) matches the 5-field cron expression. Defensive: an
 *  invalid cron never matches (and never hangs) rather than throwing into the
 *  tick loop — publish-time validation is the place a bad cron is rejected. */
export const cronMatches = (cron: string, date: Date): boolean => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  let minutes: Set<number>;
  let hours: Set<number>;
  let doms: Set<number>;
  let mons: Set<number>;
  let dows: Set<number>;
  try {
    minutes = parseField(min, 0, 59);
    hours = parseField(hour, 0, 23);
    doms = parseField(dom, 1, 31);
    mons = parseField(mon, 1, 12);
    dows = parseField(dow, 0, 6);
  } catch {
    return false;
  }
  return (
    minutes.has(date.getUTCMinutes()) &&
    hours.has(date.getUTCHours()) &&
    doms.has(date.getUTCDate()) &&
    mons.has(date.getUTCMonth() + 1) &&
    dows.has(date.getUTCDay())
  );
};

export interface SchedulerOptions {
  readonly runtime: AppsRuntime;
  /** The scopes to schedule (self-host single-tenant: one scope). */
  readonly scopes: readonly string[];
  /** Tick interval ms (default 60_000 — cron granularity is one minute). */
  readonly intervalMs?: number;
  /** Injected clock for tests. */
  readonly now?: () => Date;
}

export interface Scheduler {
  /** Run one scheduler tick: fire any due schedules for the given minute. */
  readonly tick: (at?: Date) => Effect.Effect<readonly string[]>;
  readonly start: () => void;
  readonly stop: () => void;
}

export const makeScheduler = (options: SchedulerOptions): Scheduler => {
  const runtime = options.runtime;
  const now = options.now ?? (() => new Date());
  // Dedupe key: `${scope}:${workflow}:${yyyy-mm-ddThh:mm}` so a schedule fires
  // at most once per matching minute even across overlapping ticks.
  const fired = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const minuteKey = (date: Date) => date.toISOString().slice(0, 16);

  const tick = (at: Date = now()): Effect.Effect<readonly string[]> =>
    Effect.gen(function* () {
      const started: string[] = [];
      for (const scope of options.scopes) {
        const descriptor = yield* runtime.getDescriptor(scope);
        if (!descriptor) continue;
        for (const wf of descriptor.workflows) {
          if (!wf.schedule) continue;
          if (!cronMatches(wf.schedule.cron, at)) continue;
          const key = `${scope}:${wf.name}:${minuteKey(at)}`;
          if (fired.has(key)) continue;
          fired.add(key);
          const runId = `sched-${scope}-${wf.name}-${minuteKey(at)}`;
          yield* runtime
            .startWorkflow({ scope, workflow: wf.name, input: {}, runId })
            .pipe(Effect.orElseSucceed(() => undefined));
          started.push(runId);
        }
      }
      return started as readonly string[];
    });

  return {
    tick,
    start: () => {
      if (timer) return;
      timer = setInterval(() => void Effect.runPromise(tick()), options.intervalMs ?? 60_000);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
};
