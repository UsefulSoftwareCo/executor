/**
 * The rule for a stack layer whose e2e block says `skip`, without the reads: what one look at the
 * pull requests above says, how long to wait for a better answer, and what to tell the author.
 * scripts/ci/worker-baseline.ts `above` reads GitHub and drives it; e2e/tests/worker-sizes.spec.ts
 * replays real pushes through the same functions.
 *
 * A skip layer runs nothing and passes on the strength of the layer above, so that layer's run must
 * have been computed with this layer in its chain: its record (the select job's `ci-tested-…`
 * artifact) says it was built on this layer's head and compared Worker sizes with the branch this
 * layer's stack ends on. The E2E selection always compares with main, so the base commit covers it.
 *
 * A layer that is ready for review can be merged, alone or with the layers below it, so it passes
 * only on what gates a merge: a run of a ready layer above that contains this head and finished
 * green, its `checks / check` and `checks / e2e` passed, having run the full suite or the
 * narrowing table's selection (record `gate` full or narrowed, e2e/ci-selection.ts); or a ready
 * skip layer above whose own check passed by this rule (`gate` stack, `above` pass). The layer above
 * must be ready when the check looks, not only when its run started. A draft's run never passes
 * it: it runs only its block's selection. A draft skip layer, which cannot be merged, is
 * checked only to have been computed on.
 */

import { Cause, Effect } from "effect";

/**
 * Observe or enforce. Observing, the step works out the decision exactly as it would enforce it,
 * logs it (`decisionLine`) and passes, as a skip layer always passed: a pull request above exists,
 * which the select step has already required. Enforcing, a decision to fail fails the step.
 *
 * It enforces on a layer ready for review, which can be merged; a draft, which cannot (and whose
 * e2e job never reports the required check, checks.yml), is observed. Marking it ready runs it
 * again, enforced.
 */
export const enforcing = (lower: { readonly ready: boolean }) => lower.ready;

/**
 * The format of the record this workflow writes (RECORD_FORMAT in checks.yml). Format 3 adds
 * `tested`, the merge commit the run checked out; format 4 adds `gate`, what the run vouches for.
 * Format 2 and 3 records are still read, by the rule that fits them (`judgeRecord`), and never
 * pass a ready layer.
 */
export const recordFormat = "4";
/** The formats this check reads. Any other is never passed: it waits, and then fails. */
const readFormats = new Set(["2", "3", "4"]);

/**
 * How long to wait for a better answer, in seconds from the start of the step, by what was seen:
 * - `stale`: the run above recorded another base commit or baseline. A push to it, or a re-run,
 *   may still come; only the deadline fails.
 * - `noRun`: no CI run on the current head above, or none that recorded.
 * - `selecting`: a run on the head above has not finished choosing what it tests. Runners can start
 *   the layer above's select 9 to 11 minutes after this one's (15 and 16 Nov).
 * - `chained`: that run is itself a skip layer waiting on the layer above it. Its record comes a
 *   poll after its own check passes, so each layer below needs a little longer than the one above:
 *   every layer of a stack starts together, the layer second from the top waits up to `selecting`
 *   for the top, and each layer under it notices its upper's record within one poll (at most 60
 *   s), so `chained` covers five layers under the one waiting on the top.
 *
 * - `testing`: a ready layer above chose what gates a merge, and its run has not finished. A full
 *   run on main took 8 to 20 minutes (17 and 18 Nov); this leaves room for a slow one and for the
 *   layers between.
 *
 * select's timeout (checks.yml) covers the description wait (3 minutes) and `testing`, the longest.
 */
export const bounds = {
  stale: 240,
  noRun: 240,
  selecting: 900,
  chained: 1200,
  testing: 3000,
} as const;
export type Bound = keyof typeof bounds;

/** Seconds before each next look: no more often than every 20 seconds, then backing off to 60. */
export const pollAfter = (polls: number) => [20, 30, 45][polls] ?? 60;

/** The fields of a record the check reads. */
export interface RecordFields {
  readonly format?: string | undefined;
  readonly base?: string | undefined;
  readonly baseline?: string | undefined;
  /** A skip layer's own check: `pass` or `fail`; `none` for a layer that does not skip. */
  readonly above?: string | undefined;
  /** Format 3: the merge commit the run checked out and tested (`git rev-parse HEAD`). */
  readonly tested?: string | undefined;
  /** Format 4: what the run vouches for: `full`, `narrowed`, `draft` or (a skip layer) `stack`. */
  readonly gate?: string | undefined;
}

export const parseRecord = (text: string): RecordFields => {
  const field = (key: string) => text.match(new RegExp(`^${key} (\\S+)$`, "m"))?.[1];
  return {
    format: field("format"),
    base: field("base"),
    baseline: field("baseline"),
    above: field("above"),
    tested: field("tested"),
    gate: field("gate"),
  };
};

/** One CI run of this repository on the current head of a pull request above. */
export interface RunSeen {
  readonly id: number;
  readonly url: string;
  /** The newest record it uploaded, if any. */
  readonly record?: RecordFields | undefined;
  /** Its select job has finished (or the run has). */
  readonly selectDone: boolean;
  /** Its select job is in its own skip check, waiting on the layer above it. */
  readonly waitingAbove: boolean;
  /**
   * Format 3: whether the lower layer's head is an ancestor of the commit the run tested (the
   * reader asks GitHub's compare API); undefined when the record names no tested commit or the
   * answer could not be read.
   */
  readonly contains?: boolean | undefined;
  /**
   * The state of its `checks / check` and `checks / e2e` jobs: how each ended (`success`,
   * `failure`, `cancelled`, `skipped`, ...), its status while it has not (`queued`,
   * `in_progress`, ...), `missing` when the run ended without it, or undefined while it is not
   * listed yet: read for a ready layer's check only (`gateOutcome`).
   */
  readonly gates?:
    | { readonly check?: string | undefined; readonly e2e?: string | undefined }
    | undefined;
  /** The run was cancelled as a whole: it counts only when no other run on the head is live. */
  readonly cancelled?: boolean | undefined;
}

/** One open pull request of this repository whose base is this layer's branch. */
export interface UpperSeen {
  readonly pull: number;
  readonly head: string;
  /**
   * Whether it is a draft now, as the pull request list says at this look: a run it made while
   * ready proves nothing once it is a draft again, since a draft is not merged.
   */
  readonly draft: boolean;
  /**
   * Its CI runs on `head` that were not cancelled, newest first; or, when every run on it was
   * cancelled, the newest, marked `cancelled`.
   */
  readonly runs: ReadonlyArray<RunSeen>;
}

/** What one look saw: the pull requests above, or why they could not be read. */
export type Observation =
  | { readonly _tag: "Read"; readonly uppers: ReadonlyArray<UpperSeen> }
  | { readonly _tag: "Unread"; readonly why: string };

export interface Lower {
  readonly ref: string;
  readonly head: string;
  /** The branch this layer's stack ends on, from its own baseline. */
  readonly bottom: string;
  readonly repository: string;
  readonly runId: string;
  /** Ready for review: it passes only on a merge gate above (`judgeRecord`). */
  readonly ready: boolean;
}

/**
 * The rule that passed a run: `old`, a record from before this check (a pull request above
 * exists); `base`, the run's event named this layer's head as its base (format 2 and 3); `tested`,
 * the merge commit the run tested contains this layer's head (format 3).
 */
export type Rule = "old" | "base" | "tested" | "gate";

/** What one look says: pass, wait for a better answer, or fail now, since none can come. */
export type Verdict =
  | {
      readonly _tag: "Pass";
      readonly pull: number;
      readonly run: string;
      /** The record above is in the format from before this check: judged by the old rule. */
      readonly oldFormat: boolean;
      readonly rule: Rule;
    }
  | {
      readonly _tag: "Wait";
      readonly bound: Bound;
      readonly why: string;
      readonly remedy?: string | undefined;
    }
  | {
      readonly _tag: "Fail";
      readonly why: string;
      readonly remedy?: string | undefined;
    };

const short = (sha: string) => sha.slice(0, 9);

/** The job states that are not an outcome yet: the job may still pass. */
const unfinished = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/**
 * How a merge gate's required checks stand, failures first: one that ended any way but `success`
 * (failed, cancelled, skipped, or missing from a run that has ended) decides the run, whatever the
 * other is doing, since a run whose required check failed cannot pass. Only while nothing has
 * failed and one has not ended is the run still testing.
 */
export const gateOutcome = (gates: {
  readonly check?: string | undefined;
  readonly e2e?: string | undefined;
}) => {
  const jobs = [
    { name: "checks / check", state: gates.check },
    { name: "checks / e2e", state: gates.e2e },
  ];
  const ended = (state: string | undefined): state is string =>
    state !== undefined && !unfinished.has(state);
  const failed = jobs.filter((job) => ended(job.state) && job.state !== "success");
  if (failed.length > 0)
    return {
      _tag: "Failed" as const,
      failed,
      jobs,
      running: jobs.filter((job) => !ended(job.state)),
    };
  if (jobs.every((job) => job.state === "success")) return { _tag: "Passed" as const };
  return { _tag: "Testing" as const };
};

/** What one run's record says: it fits, or why not. */
const judgeRecord = (
  upper: UpperSeen,
  run: RunSeen,
  record: RecordFields,
  lower: Lower,
): Verdict => {
  const rerun = `run it again: gh run rerun ${run.id} --repo ${lower.repository}`;
  // TRANSITION. An upper's run uses the workflow of its merge into this branch, so until a stack
  // is rebased onto a main that writes `format`, its records are in main's format from before
  // this check: neither `format` nor `baseline` (and often no `base`). Such a run compared
  // Worker sizes with main, so it cannot have laundered a branch's growth; it is judged by the
  // old rule, which passes, and leaves only the stale-upper weakness the old rule always had. (A
  // record with a baseline and no format came only from this check's own pull requests before
  // `format` was added; it is judged by the fields it has.)
  // Before deleting this branch and `oldFormat`: this command, from any checkout, must list no
  // pull request, that is, no open upper above a skip layer would still write main's old format:
  //   R=UsefulSoftwareCo/executor-next; gh pr list -R $R --state open -L 1000 --json number,baseRefName,headRefName,isCrossRepository,body -q '[.[]|select(.isCrossRepository|not)] as $p | ($p|map(select(.body|test("```e2e\\s+skip\\s+```"))|.headRefName)) as $s | $p[]|select(.baseRefName as $b|$s|index($b))|.number' | while read n; do gh api "repos/$R/contents/.github/workflows/checks.yml?ref=refs/pull/$n/merge" -q .content | base64 -d | grep -q RECORD_FORMAT || echo "#$n"; done
  if (record.format === undefined && record.baseline === undefined && !lower.ready)
    return { _tag: "Pass", pull: upper.pull, run: run.url, oldFormat: true, rule: "old" };
  if (!readFormats.has(record.format ?? "2"))
    return {
      _tag: "Wait",
      bound: "stale",
      why: `#${upper.pull}'s latest run on its head, ${run.url}, wrote a record in format ${record.format}, which this check does not read`,
      remedy: `bring this layer up to date with main and push it`,
    };
  // A skip layer's own check that did not pass: under enforcement it would have written no record.
  if (record.above !== undefined && record.above !== "pass" && record.above !== "none")
    return {
      _tag: "Wait",
      bound: "stale",
      why: `#${upper.pull} is itself a skip layer, and its own check of the layer above it fails (${run.url})`,
      remedy: `fix #${upper.pull} as its run says`,
    };
  // Built on this layer's head: its event named it as the base, or (format 3) the commit the run
  // tested contains it. The event's base alone is not enough: a stack push can send an upper's
  // `synchronize` event twice, one carrying the lower layer's previous head as its base, while the
  // merge commit GitHub built for it already holds this layer's head (#4718, 16 Nov). A re-run
  // keeps its event's base, but tests the same merge commit.
  const builtOn: Rule | undefined =
    record.base === lower.head
      ? "base"
      : record.tested !== undefined && run.contains === true
        ? "tested"
        : undefined;
  if (builtOn === undefined && record.tested !== undefined && run.contains === undefined)
    return {
      _tag: "Wait",
      bound: "stale",
      why: `#${upper.pull}'s latest run on its head, ${run.url}, tested ${short(record.tested)}, and whether that contains this layer's head ${short(lower.head)} could not be read`,
    };
  if (builtOn === undefined)
    return {
      _tag: "Wait",
      bound: "stale",
      why: `#${upper.pull}'s latest run on its head, ${run.url}, was built on ${record.base === undefined ? "a base it did not record" : short(record.base)}${record.tested === undefined ? "" : ` and tested ${short(record.tested)}, which does not contain`}${record.tested === undefined ? ", not" : ""} this layer's head ${short(lower.head)}`,
      remedy: `bring #${upper.pull} up to date with this layer and push it (gh stack rebase, then gh stack push), which runs it on this layer's head`,
    };
  const baseline = record.baseline?.replace(/@[^@]*$/, "");
  if (baseline !== lower.bottom)
    return {
      _tag: "Wait",
      bound: "stale",
      why: `#${upper.pull}'s latest run on its head, ${run.url}, compared its Worker sizes with ${baseline ?? "a baseline it did not record"}, not ${lower.bottom}, the base this stack now ends on`,
      remedy: `${rerun} (a re-run reads the stack afresh)`,
    };
  if (!lower.ready)
    return { _tag: "Pass", pull: upper.pull, run: run.url, oldFormat: false, rule: builtOn };
  // Ready: only a merge gate above passes it, of a layer that is ready now. A layer marked ready,
  // run in full and turned back into a draft keeps that run on its head, but it is no merge gate.
  const ready = `mark #${upper.pull} ready for review (gh pr ready ${upper.pull}), which runs it as a merge gate, and push or rerun it`;
  if (upper.draft)
    return {
      _tag: "Wait",
      bound: "stale",
      why: `this layer is ready for review, and #${upper.pull} is a draft now, so no run of it gates a merge`,
      remedy: ready,
    };
  if (record.gate === "stack")
    return record.above === "pass"
      ? { _tag: "Pass", pull: upper.pull, run: run.url, oldFormat: false, rule: "gate" }
      : {
          _tag: "Wait",
          bound: "stale",
          why: `#${upper.pull}'s latest run on its head, ${run.url}, is a skip layer's whose own check did not pass`,
          remedy: `fix #${upper.pull} as its run says`,
        };
  if (record.gate !== "full" && record.gate !== "narrowed")
    return {
      _tag: "Wait",
      bound: "stale",
      why: `this layer is ready for review, and #${upper.pull}'s latest run on its head, ${run.url}, ${record.gate === "draft" ? "is a draft's, which runs only its block's selection" : "recorded no merge gate (a workflow from before this rule)"}`,
      remedy:
        record.gate === "draft" ? ready : `bring #${upper.pull} up to date with main and push it`,
    };
  // Failures first: a required check that has failed decides, even while the other runs.
  const outcome = gateOutcome(run.gates ?? {});
  if (outcome._tag === "Passed")
    return { _tag: "Pass", pull: upper.pull, run: run.url, oldFormat: false, rule: "gate" };
  if (outcome._tag === "Testing")
    return {
      _tag: "Wait",
      bound: "testing",
      why: `#${upper.pull}'s run on its head, ${run.url}, runs ${record.gate === "full" ? "the full suite" : "the narrowing table's selection"} for a merge and has not finished`,
    };
  const { running } = outcome;
  const states = (jobs: typeof outcome.jobs) =>
    jobs.map((job) => `${job.name} ${job.state ?? "not listed yet"}`).join(" and ");
  return {
    _tag: "Fail",
    why:
      running.length === 0
        ? `#${upper.pull}'s run on its head, ${run.url}, ended with ${states(outcome.jobs)}`
        : `#${upper.pull}'s run on its head, ${run.url}, has failed: ${outcome.failed.map((job) => `${job.name} ended ${job.state}`).join(" and ")} while ${running.map((job) => `${job.name} is ${job.state ?? "not listed yet"}`).join(" and ")}, so it cannot pass`,
    remedy: `fix #${upper.pull}, or ${running.length === 0 ? "" : "once that run has ended, "}${rerun} if it failed on something else`,
  };
};

/** What one pull request above says, from its runs on its current head. */
const judgeUpper = (seen: UpperSeen, lower: Lower): Verdict => {
  const rerun = (run: RunSeen) => `run it again: gh run rerun ${run.id} --repo ${lower.repository}`;
  // A run cancelled as a whole failed both required checks and runs no further. It is not judged
  // by its record (it may have recorded and then stopped) and counts only when no other run on the
  // head is live: then nothing on this head can pass until someone runs it again.
  const live = seen.runs.filter((run) => run.cancelled !== true);
  const cancelled = seen.runs.find((run) => run.cancelled === true);
  if (live.length === 0 && cancelled !== undefined)
    return {
      _tag: "Fail",
      why: `#${seen.pull}'s run on its head, ${cancelled.url}, was cancelled, and no other run on its head ${short(seen.head)} is live`,
      remedy: `${rerun(cancelled)}, or push to #${seen.pull}`,
    };
  const upper = { ...seen, runs: live };
  // Any run on the current head whose record fits passes: it tested this layer's head against the
  // right bottom, whatever another run on the same head recorded. A stack push can start two runs
  // on the upper's head in the same second, one of them with the lower layer's previous head as
  // its base (#4575, 16 Nov).
  const judged = upper.runs.flatMap((run) =>
    run.record === undefined ? [] : [judgeRecord(upper, run, run.record, lower)],
  );
  const fits =
    judged.find((verdict) => verdict._tag === "Pass" && !verdict.oldFormat) ??
    judged.find((verdict) => verdict._tag === "Pass");
  if (fits !== undefined) return fits;
  // Then a fitting run still testing for a merge, with nothing required failed yet: its outcome
  // decides, so the wait is the testing bound, whatever another run on the head shows (a run the
  // head's newer run replaces, or a duplicate queued behind it). A full run can outlast the 15
  // minutes of `selecting`.
  const testing = judged.filter(
    (verdict) => verdict._tag === "Wait" && verdict.bound === "testing",
  );
  const selecting = upper.runs.filter((run) => run.record === undefined && !run.selectDone);
  if (testing.length > 0)
    return {
      _tag: "Wait",
      bound: "testing",
      why: [
        ...selecting.map(
          (run) => `#${upper.pull}'s run on its head, ${run.url}, has not chosen what it tests yet`,
        ),
        ...judged.flatMap((verdict) => (verdict._tag === "Pass" ? [] : [verdict.why])),
      ].join("; "),
    };
  // Then a fitting run whose required checks have failed: it fails now, named, rather than waiting
  // out a bound for its run to end. Before this, a failed check beside an unfinished e2e waited
  // the testing bound (50 minutes) and was never named. A run on the same head still choosing
  // does not hold it: queued behind the failed run (one concurrency group per head, ci.yml), it
  // starts only once that run ends, and then tests in full, since only a pass is handed on
  // (e2e/ci-repeat.ts). It may pass, but not within this wait's bound; it is named, so the author
  // knows to run this layer again once it has.
  const failed = judged.filter((verdict) => verdict._tag === "Fail");
  if (failed.length > 0)
    return {
      _tag: "Fail",
      why: [
        ...failed.map((verdict) => verdict.why),
        ...selecting.map(
          (run) =>
            `#${upper.pull}'s run ${run.url} on the same head has not chosen yet, and will test it again in full once that run ends`,
        ),
      ].join("; "),
      remedy: failed.flatMap((verdict) => verdict.remedy ?? []).join(", or ") || undefined,
    };
  // While any run on the head is still choosing (a duplicate waiting its turn behind the other,
  // a re-run), it may yet fit: wait for it, whatever the others recorded (#4575, 16 Nov: the
  // fitting run was the queued duplicate, and the other had the lower layer's previous head).
  if (selecting.length > 0) {
    // What the other runs on the head say is kept, so it is named if the wait runs out, not only
    // the wait (on 18 Nov #4989 failed after 905 s saying only that #4990's duplicate had not
    // chosen). They are only stale here, shorter than choosing: testing and failed were decided
    // above.
    const others = judged.filter((verdict) => verdict._tag === "Wait");
    const remedies = others.flatMap((verdict) =>
      verdict.remedy === undefined ? [] : [verdict.remedy],
    );
    return {
      _tag: "Wait",
      bound: selecting.some((run) => run.waitingAbove) ? "chained" : "selecting",
      why: [
        `#${upper.pull}'s run on its head, ${selecting[0]!.url}, has not chosen what it tests yet`,
        ...others.map((verdict) => verdict.why),
      ].join("; "),
      ...(remedies.length > 0 && { remedy: remedies.join(", or ") }),
    };
  }
  // Otherwise the newest run says why not.
  const newest = upper.runs[0];
  if (newest?.record !== undefined) return judgeRecord(upper, newest, newest.record, lower);
  if (newest !== undefined)
    return {
      _tag: "Wait",
      bound: "noRun",
      why: `#${upper.pull}'s latest run on its head, ${newest.url}, recorded nothing (its select failed)`,
      remedy: `fix #${upper.pull}'s description or ${rerun(newest)}`,
    };
  return {
    _tag: "Wait",
    bound: "noRun",
    why: `#${upper.pull} has no CI run on its head ${short(upper.head)}`,
    remedy: `push to #${upper.pull}, or run its latest CI run again`,
  };
};

/**
 * What one look says for all the pull requests above: any one computed with this layer passes.
 * Otherwise the wait is the longest any of them asks for, since another pull request above may
 * still pass it; only when every one of them has failed does it fail now. A look that failed keeps
 * the previous look's bound: not reading is not an answer.
 */
export const judge = (observation: Observation, lower: Lower, previous?: Verdict): Verdict => {
  if (observation._tag === "Unread")
    return {
      _tag: "Wait",
      bound: previous?._tag === "Wait" ? previous.bound : "noRun",
      why: `the pull requests above could not be read (${observation.why})`,
    };
  if (observation.uppers.length === 0)
    return {
      _tag: "Wait",
      bound: "noRun",
      why: `no open pull request in this repository has ${lower.ref} as its base`,
      remedy: `open the layer above with base ${lower.ref}`,
    };
  const verdicts = observation.uppers.map((upper) => judgeUpper(upper, lower));
  const passed =
    verdicts.find((verdict) => verdict._tag === "Pass" && !verdict.oldFormat) ??
    verdicts.find((verdict) => verdict._tag === "Pass");
  if (passed !== undefined) return passed;
  const unpassed = verdicts.filter((verdict) => verdict._tag !== "Pass");
  const why = unpassed.map((verdict) => verdict.why).join("; ");
  const remedy =
    unpassed
      .flatMap((verdict) => (verdict.remedy === undefined ? [] : [verdict.remedy]))
      .join(", or ") || undefined;
  const waits = unpassed.filter((verdict) => verdict._tag === "Wait");
  const longest = waits.toSorted((a, b) => bounds[b.bound] - bounds[a.bound])[0];
  return longest === undefined
    ? { _tag: "Fail", why, remedy }
    : { _tag: "Wait", bound: longest.bound, why, remedy };
};

/** The decision, once a look passes or its wait is over. */
export interface Decision {
  readonly decision: "pass" | "fail";
  readonly oldFormat: boolean;
  /** The rule that decided a pass; `none` for a fail. */
  readonly rule: Rule | "none";
  readonly reason: string;
  /** What the author is told. */
  readonly message: string;
  readonly waited: number;
}

/** After a look `elapsed` seconds into the step: the decision, or how long until the next look. */
export const next = (
  verdict: Verdict,
  lower: Lower,
  elapsed: number,
  polls: number,
):
  | { readonly _tag: "Done"; readonly decision: Decision }
  | { readonly _tag: "Poll"; readonly after: number } => {
  const waited = Math.round(elapsed);
  if (verdict._tag === "Pass")
    return {
      _tag: "Done",
      decision: {
        decision: "pass",
        oldFormat: verdict.oldFormat,
        rule: verdict.rule,
        waited,
        reason: verdict.oldFormat
          ? `#${verdict.pull}'s run ${verdict.run} wrote its record in the format from before this check, so the old rule applies: a pull request above exists`
          : verdict.rule === "gate"
            ? `#${verdict.pull}'s run ${verdict.run}, a merge gate of a ready layer above, contains ${short(lower.head)}, compared its Worker sizes with ${lower.bottom} and passed`
            : verdict.rule === "tested"
              ? `#${verdict.pull}'s run ${verdict.run} tested a merge commit that contains ${short(lower.head)}, and compared its Worker sizes with ${lower.bottom}`
              : `#${verdict.pull}'s run ${verdict.run} was built on ${short(lower.head)} and compared its Worker sizes with ${lower.bottom}`,
        message: verdict.oldFormat
          ? `The layer above runs a workflow from before the skip check. Rebasing the stack onto main turns the check on.`
          : `The layer above was computed with this layer in its chain.`,
      },
    };
  // A failure decides at once; a wait polls until its bound.
  if (verdict._tag === "Wait" && elapsed < bounds[verdict.bound])
    return { _tag: "Poll", after: Math.min(pollAfter(polls), bounds[verdict.bound] - elapsed) };
  const own = `gh run rerun ${lower.runId} --repo ${lower.repository}`;
  return {
    _tag: "Done",
    decision: {
      decision: "fail",
      oldFormat: false,
      rule: "none",
      waited,
      reason: verdict.why,
      message: `The e2e block says skip: this layer passes only when the layer above has a run on its current head computed with this layer in its chain, built on ${short(lower.head)} and comparing Worker sizes with ${lower.bottom}${lower.ready ? ", and, as this layer is ready for review, only when that run is a ready layer's merge gate (the full suite, or the narrowing table's selection) and passed" : ""}. After ${waited} s, ${verdict.why}. ${verdict.remedy === undefined ? "Once it has" : `To fix it, ${verdict.remedy}; once that run has started`}, run this one again: ${own}`,
    },
  };
};

/** What the step came to: a decision, or a defect that kept it from deciding. */
export type Outcome =
  | { readonly _tag: "Decided"; readonly decision: Decision }
  | { readonly _tag: "Error"; readonly why: string };

/**
 * The check, made unable to fail the step while observing: any failure or defect inside it (a
 * shape `judge` or `next` did not expect, a missing variable, a write that failed) becomes the
 * `error` outcome. Enforcing, it fails the step as any defect would.
 */
export const guarded = <R>(
  check: Effect.Effect<Decision, unknown, R>,
  enforcing: boolean,
): Effect.Effect<Outcome, unknown, R> => {
  const decided = Effect.map(check, (decision): Outcome => ({ _tag: "Decided", decision }));
  return enforcing
    ? decided
    : decided.pipe(
        Effect.catchCause((cause) =>
          Effect.succeed<Outcome>({
            _tag: "Error",
            why: String(Cause.squash(cause)).split("\n")[0]!,
          }),
        ),
      );
};

/** The one log line a day of decisions is counted from. */
export const decisionLine = (outcome: Outcome, enforcing: boolean) =>
  `skip-check ${JSON.stringify(
    outcome._tag === "Error"
      ? { mode: enforcing ? "enforce" : "observe", decision: "error", reason: outcome.why }
      : {
          mode: enforcing ? "enforce" : "observe",
          decision: `${enforcing ? "" : "would "}${outcome.decision.decision}`,
          oldFormat: outcome.decision.oldFormat,
          rule: outcome.decision.rule,
          waited: outcome.decision.waited,
          reason: outcome.decision.reason,
          message: outcome.decision.message,
        },
  )}`;

/** The summary sentence for an outcome. */
export const summarySentence = (outcome: Outcome, enforcing: boolean) => {
  if (outcome._tag === "Error")
    return `The skip check could not decide: ${outcome.why}.${enforcing ? "" : " It passes while observing."}`;
  const { decision } = outcome;
  const would = enforcing ? "" : "would ";
  return decision.decision === "pass"
    ? `The skip check ${would}pass${enforcing ? "es" : ""}: ${decision.reason}.`
    : `The skip check ${would}fail${enforcing ? "s" : ""}: ${decision.reason}. The author ${enforcing ? "is" : "would be"} told: ${decision.message}`;
};

/** Whether the step fails: only a decision to fail, or a defect, and only when enforcing. */
export const fails = (outcome: Outcome, enforcing: boolean) =>
  enforcing && (outcome._tag === "Error" || outcome.decision.decision === "fail");
