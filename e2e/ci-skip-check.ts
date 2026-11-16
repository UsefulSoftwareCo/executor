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
 */

import { Cause, Effect } from "effect";

/**
 * Observe or enforce. Observing, the step works out the decision exactly as it would enforce it,
 * logs it (`decisionLine`) and passes, as a skip layer always passed: a pull request above exists,
 * which the select step has already required. Enforcing, a decision to fail fails the step.
 */
export const enforce = false;

/** The format of the record this workflow writes (RECORD_FORMAT in checks.yml). */
export const recordFormat = "2";

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
 * select's timeout (checks.yml) covers the description wait (3 minutes) and `chained`, the longest.
 */
export const bounds = { stale: 240, noRun: 240, selecting: 900, chained: 1200 } as const;
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
}

export const parseRecord = (text: string): RecordFields => {
  const field = (key: string) => text.match(new RegExp(`^${key} (\\S+)$`, "m"))?.[1];
  return {
    format: field("format"),
    base: field("base"),
    baseline: field("baseline"),
    above: field("above"),
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
}

/** One open pull request of this repository whose base is this layer's branch. */
export interface UpperSeen {
  readonly pull: number;
  readonly head: string;
  /** Its CI runs on `head` that were not cancelled, newest first. */
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
}

/** What one look says. */
export type Verdict =
  | {
      readonly _tag: "Pass";
      readonly pull: number;
      readonly run: string;
      /** The record above is in the format from before this check: judged by the old rule. */
      readonly oldFormat: boolean;
    }
  | {
      readonly _tag: "Wait";
      readonly bound: Bound;
      readonly why: string;
      readonly remedy?: string | undefined;
    };

const short = (sha: string) => sha.slice(0, 9);

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
  if (record.format === undefined && record.baseline === undefined)
    return { _tag: "Pass", pull: upper.pull, run: run.url, oldFormat: true };
  if ((record.format ?? recordFormat) !== recordFormat)
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
  // A re-run reads the stack afresh but keeps its event, so the base commit it was built on.
  if (record.base !== lower.head)
    return {
      _tag: "Wait",
      bound: "stale",
      why: `#${upper.pull}'s latest run on its head, ${run.url}, was built on ${record.base === undefined ? "a base it did not record" : short(record.base)}, not this layer's head ${short(lower.head)}`,
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
  return { _tag: "Pass", pull: upper.pull, run: run.url, oldFormat: false };
};

/** What one pull request above says, from its runs on its current head. */
const judgeUpper = (upper: UpperSeen, lower: Lower): Verdict => {
  const rerun = (run: RunSeen) => `run it again: gh run rerun ${run.id} --repo ${lower.repository}`;
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
  // While any run on the head is still choosing (a duplicate waiting its turn behind the other,
  // a re-run), it may yet fit: wait for it, whatever the others recorded (#4575, 16 Nov: the
  // fitting run was the queued duplicate, and the other had the lower layer's previous head).
  const selecting = upper.runs.filter((run) => run.record === undefined && !run.selectDone);
  if (selecting.length > 0)
    return {
      _tag: "Wait",
      bound: selecting.some((run) => run.waitingAbove) ? "chained" : "selecting",
      why: `#${upper.pull}'s run on its head, ${selecting[0]!.url}, has not chosen what it tests yet`,
    };
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
 * Otherwise the wait is the longest any of them asks for. A look that failed keeps the previous
 * look's bound: not reading is not an answer.
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
  const waits = verdicts.filter((verdict) => verdict._tag === "Wait");
  const longest = waits.toSorted((a, b) => bounds[b.bound] - bounds[a.bound])[0]!;
  return {
    _tag: "Wait",
    bound: longest.bound,
    why: waits.map((verdict) => verdict.why).join("; "),
    remedy:
      waits
        .flatMap((verdict) => (verdict.remedy === undefined ? [] : [verdict.remedy]))
        .join(", or ") || undefined,
  };
};

/** The decision, once a look passes or its wait is over. */
export interface Decision {
  readonly decision: "pass" | "fail";
  readonly oldFormat: boolean;
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
        waited,
        reason: verdict.oldFormat
          ? `#${verdict.pull}'s run ${verdict.run} wrote its record in the format from before this check, so the old rule applies: a pull request above exists`
          : `#${verdict.pull}'s run ${verdict.run} was built on ${short(lower.head)} and compared its Worker sizes with ${lower.bottom}`,
        message: verdict.oldFormat
          ? `The layer above runs a workflow from before the skip check. Rebasing the stack onto main turns the check on.`
          : `The layer above was computed with this layer in its chain.`,
      },
    };
  if (elapsed < bounds[verdict.bound])
    return { _tag: "Poll", after: Math.min(pollAfter(polls), bounds[verdict.bound] - elapsed) };
  const own = `gh run rerun ${lower.runId} --repo ${lower.repository}`;
  return {
    _tag: "Done",
    decision: {
      decision: "fail",
      oldFormat: false,
      waited,
      reason: verdict.why,
      message: `The e2e block says skip: this layer passes only when the layer above has a run on its current head computed with this layer in its chain, built on ${short(lower.head)} and comparing Worker sizes with ${lower.bottom}. After ${waited} s, ${verdict.why}. ${verdict.remedy === undefined ? "Once it has" : `To fix it, ${verdict.remedy}; once that run has started`}, run this one again: ${own}`,
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
export const decisionLine = (outcome: Outcome, enforcing = enforce) =>
  `skip-check ${JSON.stringify(
    outcome._tag === "Error"
      ? { mode: enforcing ? "enforce" : "observe", decision: "error", reason: outcome.why }
      : {
          mode: enforcing ? "enforce" : "observe",
          decision: `${enforcing ? "" : "would "}${outcome.decision.decision}`,
          oldFormat: outcome.decision.oldFormat,
          waited: outcome.decision.waited,
          reason: outcome.decision.reason,
          message: outcome.decision.message,
        },
  )}`;

/** The summary sentence for an outcome. */
export const summarySentence = (outcome: Outcome, enforcing = enforce) => {
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
