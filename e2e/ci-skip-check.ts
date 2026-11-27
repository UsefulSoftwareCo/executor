import { Cause, Effect } from "effect";

export const enforcing = (lower: { readonly ready: boolean }) => lower.ready;

export const recordFormat = "4";
const readFormats = new Set(["2", "3", "4"]);

export const bounds = {
  stale: 240,
  noRun: 240,
  selecting: 900,
  chained: 1200,
  testing: 3000,
} as const;
export type Bound = keyof typeof bounds;

export const pollAfter = (polls: number) => [20, 30, 45][polls] ?? 60;

export interface RecordFields {
  readonly format?: string | undefined;
  readonly base?: string | undefined;
  readonly baseline?: string | undefined;
  readonly above?: string | undefined;
  readonly tested?: string | undefined;
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

export interface RunSeen {
  readonly id: number;
  readonly url: string;
  readonly record?: RecordFields | undefined;
  readonly selectDone: boolean;
  readonly waitingAbove: boolean;
  readonly contains?: boolean | undefined;
  readonly gates?:
    | { readonly check?: string | undefined; readonly e2e?: string | undefined }
    | undefined;
  readonly cancelled?: boolean | undefined;
}

export interface UpperSeen {
  readonly pull: number;
  readonly head: string;
  readonly draft: boolean;
  readonly runs: ReadonlyArray<RunSeen>;
}

export type Observation =
  | { readonly _tag: "Read"; readonly uppers: ReadonlyArray<UpperSeen> }
  | { readonly _tag: "Unread"; readonly why: string };

export interface Lower {
  readonly ref: string;
  readonly head: string;
  readonly bottom: string;
  readonly repository: string;
  readonly runId: string;
  readonly ready: boolean;
}

export type Rule = "old" | "base" | "tested" | "gate";

export type Verdict =
  | {
      readonly _tag: "Pass";
      readonly pull: number;
      readonly run: string;
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

const unfinished = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

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

const judgeRecord = (
  upper: UpperSeen,
  run: RunSeen,
  record: RecordFields,
  lower: Lower,
): Verdict => {
  const rerun = `run it again: gh run rerun ${run.id} --repo ${lower.repository}`;
  if (record.format === undefined && record.baseline === undefined && !lower.ready)
    return { _tag: "Pass", pull: upper.pull, run: run.url, oldFormat: true, rule: "old" };
  if (!readFormats.has(record.format ?? "2"))
    return {
      _tag: "Wait",
      bound: "stale",
      why: `#${upper.pull}'s latest run on its head, ${run.url}, wrote a record in format ${record.format}, which this check does not read`,
      remedy: `bring this layer up to date with main and push it`,
    };
  if (record.above !== undefined && record.above !== "pass" && record.above !== "none")
    return {
      _tag: "Wait",
      bound: "stale",
      why: `#${upper.pull} is itself a skip layer, and its own check of the layer above it fails (${run.url})`,
      remedy: `fix #${upper.pull} as its run says`,
    };
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

const judgeUpper = (seen: UpperSeen, lower: Lower): Verdict => {
  const rerun = (run: RunSeen) => `run it again: gh run rerun ${run.id} --repo ${lower.repository}`;
  const live = seen.runs.filter((run) => run.cancelled !== true);
  const cancelled = seen.runs.find((run) => run.cancelled === true);
  if (live.length === 0 && cancelled !== undefined)
    return {
      _tag: "Fail",
      why: `#${seen.pull}'s run on its head, ${cancelled.url}, was cancelled, and no other run on its head ${short(seen.head)} is live`,
      remedy: `${rerun(cancelled)}, or push to #${seen.pull}`,
    };
  const upper = { ...seen, runs: live };
  const judged = upper.runs.flatMap((run) =>
    run.record === undefined ? [] : [judgeRecord(upper, run, run.record, lower)],
  );
  const fits =
    judged.find((verdict) => verdict._tag === "Pass" && !verdict.oldFormat) ??
    judged.find((verdict) => verdict._tag === "Pass");
  if (fits !== undefined) return fits;
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
  if (selecting.length > 0) {
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

export interface Decision {
  readonly decision: "pass" | "fail";
  readonly oldFormat: boolean;
  readonly rule: Rule | "none";
  readonly reason: string;
  readonly message: string;
  readonly waited: number;
}

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

export type Outcome =
  | { readonly _tag: "Decided"; readonly decision: Decision }
  | { readonly _tag: "Error"; readonly why: string };

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

export const summarySentence = (outcome: Outcome, enforcing: boolean) => {
  if (outcome._tag === "Error")
    return `The skip check could not decide: ${outcome.why}.${enforcing ? "" : " It passes while observing."}`;
  const { decision } = outcome;
  const would = enforcing ? "" : "would ";
  return decision.decision === "pass"
    ? `The skip check ${would}pass${enforcing ? "es" : ""}: ${decision.reason}.`
    : `The skip check ${would}fail${enforcing ? "s" : ""}: ${decision.reason}. The author ${enforcing ? "is" : "would be"} told: ${decision.message}`;
};

export const fails = (outcome: Outcome, enforcing: boolean) =>
  enforcing && (outcome._tag === "Error" || outcome.decision.decision === "fail");
