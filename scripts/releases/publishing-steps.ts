/**
 * Which steps of a release run publish something, so a failed attempt is judged by what its failed
 * step does, not by the name of its job (scripts/releases/beta-due.ts).
 *
 * A failure in a step that builds, tests, sets up or writes the notes publishes nothing, so another
 * attempt may start, as soon as main is green again. A failure in a step that publishes anything,
 * an image tag, a GitHub release or its assets, the npm launcher, the Homebrew formula, the desktop
 * feed or the Bun runtime's own release, may have left something public that a new run cannot
 * replace: the run's failed jobs are re-run once from its own artifacts, and after that someone
 * inspects it (RELEASING.md, "Publish beta"). It never gets the early retry.
 *
 * Each step of the release workflows says which it is, in its own `env`: `PUBLISHES: "yes"` or
 * `PUBLISHES: "no"` (GitHub allows no other key of a step's own; the variable is otherwise unused).
 * `classificationProblems` fails a step without it, so a new step is never taken for one that
 * publishes nothing by default; e2e/tests/beta-due.spec.ts runs it through
 * scripts/releases/publishing-steps-check.ts. Nothing guesses from a step's command.
 *
 * A run's jobs are matched to the workflow's by job id, never by the whole name GitHub shows, which
 * it cuts short (beta.61's failed Windows CLI job ended in an ellipsis). GitHub names a job by its
 * id, or by its `name:`, followed by its matrix values in parentheses, and a job of a called
 * workflow by the caller's id, ` / `, and that job's name; `classificationProblems` requires every
 * `name:` to start with the job's id, so the id always starts what GitHub shows. A step is matched
 * by the name GitHub shows for it; one that matches none of its job's steps counts as publishing.
 */

import { parse } from "yaml";

/** The release workflows under .github/workflows/: their files' texts, by file name. */
export type ReleaseWorkflows = Readonly<Record<string, string>>;

/** The workflow a run's jobs come from, and the workflows its jobs call. */
export const releaseWorkflow = "release-artifacts.yml";

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly name?: string;
  readonly uses?: string;
  readonly steps?: ReadonlyArray<WorkflowStep>;
}

const jobsOf = (text: string) =>
  (parse(text) as { jobs: Readonly<Record<string, WorkflowJob>> }).jobs;

/** The name GitHub shows for a step: its `name:`, or `Run ` and its action or first command line. */
const shownName = (step: WorkflowStep) =>
  step.name ?? `Run ${step.uses ?? (step.run ?? "").trim().split("\n")[0]}`;

/** A step's own declaration: `yes`, `no`, or undefined when it has none or another value. */
const declared = (step: WorkflowStep) => {
  const value = step.env?.["PUBLISHES"];
  return value === "yes" || value === "no" ? value : undefined;
};

/** The called workflow's file, for a job that calls one in this repository. */
const calledFile = (job: WorkflowJob) =>
  /^\.\/\.github\/workflows\/(.+)$/u.exec(job.uses ?? "")?.[1];

/**
 * The id of the workflow job a run's job is, from the start of the name GitHub shows: the longest
 * id that is the whole name or is followed by a space.
 */
const jobIdIn = (ids: ReadonlyArray<string>, shown: string) =>
  ids
    .filter((id) => shown === id || shown.startsWith(`${id} `))
    .toSorted((a, b) => b.length - a.length)[0];

/** A job of a run as `gh run view --json jobs` lists it. */
export interface RunJob {
  readonly name: string;
  readonly conclusion: string;
  readonly steps: ReadonlyArray<{ readonly name: string; readonly conclusion: string }>;
}

/** Conclusions that leave nothing half done. */
const settled = new Set(["success", "skipped", "neutral"]);

/** The runner's own steps, around the workflow's: they run nothing of it. */
const runnerSteps = new Set(["Set up job", "Complete job", "Set up runner", "Complete runner"]);

/**
 * The publishing steps of a run that did not end cleanly, as `job: step`: each step of a job that
 * failed or was cancelled whose conclusion is not success or skipped (one that failed, was
 * cancelled, or never ended) and that declares `PUBLISHES: "yes"`. What cannot be told apart counts
 * as publishing, so it is never retried early: a job whose id is not in the workflows, and a step
 * that is not one of its job's own (an action's `Post` step counts as the step it follows).
 */
export const publishingFailures = (
  jobs: ReadonlyArray<RunJob>,
  workflows: ReleaseWorkflows,
): ReadonlyArray<string> => {
  const top = jobsOf(workflows[releaseWorkflow]!);
  return jobs
    .filter((job) => !settled.has(job.conclusion))
    .flatMap((job) => {
      const [caller, ...rest] = job.name.split(" / ");
      const callerId = jobIdIn(Object.keys(top), rest.length === 0 ? job.name : caller!);
      const callerJob = callerId === undefined ? undefined : top[callerId];
      const called = callerJob === undefined ? undefined : calledFile(callerJob);
      const calledJobs =
        called === undefined || workflows[called] === undefined
          ? undefined
          : jobsOf(workflows[called]);
      const own =
        rest.length === 0
          ? callerJob
          : calledJobs === undefined
            ? undefined
            : calledJobs[jobIdIn(Object.keys(calledJobs), rest.join(" / ")) ?? ""];
      if (own?.steps === undefined)
        return [`${job.name} (a job of no release workflow: what it publishes is unknown)`];
      const steps = own.steps;
      return job.steps
        .filter((step) => !settled.has(step.conclusion) && !runnerSteps.has(step.name))
        .filter((step) => {
          const name = step.name.replace(/^Post /u, "");
          const matching = steps.filter(
            (candidate) => shownName(candidate) === step.name || shownName(candidate) === name,
          );
          return (
            matching.length === 0 || matching.some((candidate) => declared(candidate) !== "no")
          );
        })
        .map((step) => `${job.name}: ${step.name}`);
    });
};

/**
 * What keeps the declarations honest, for e2e/tests/beta-due.spec.ts: each problem with the
 * release workflows' texts, by file name. A step without `PUBLISHES: "yes"` or `"no"`, a job's
 * `name:` that does not start with its id, and a job without steps that calls no workflow read
 * here.
 */
export const classificationProblems = (workflows: ReleaseWorkflows): ReadonlyArray<string> =>
  Object.entries(workflows).flatMap(([file, text]) =>
    Object.entries(jobsOf(text)).flatMap(([id, job]) => [
      ...(job.name === undefined || job.name === id || job.name.startsWith(`${id} `)
        ? []
        : [
            `${file}: job ${id} is named "${job.name}", which does not start with its id; a run's job is found by its id at the start of its name`,
          ]),
      ...(job.steps === undefined &&
      (calledFile(job) === undefined || !(calledFile(job)! in workflows))
        ? [`${file}: job ${id} has no steps and calls no workflow this check reads`]
        : []),
      ...(job.steps ?? []).flatMap((step, index) => {
        const which = `${file}: job ${id}'s step ${index + 1} (${shownName(step)})`;
        const value = declared(step);
        if (value === undefined)
          return [
            `${which} does not say whether it publishes: give it env PUBLISHES "yes" or "no"`,
          ];
        return [];
      }),
    ]),
  );
