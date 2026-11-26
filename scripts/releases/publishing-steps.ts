import { parse } from "yaml";

export type ReleaseWorkflows = Readonly<Record<string, string>>;

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

const shownName = (step: WorkflowStep) =>
  step.name ?? `Run ${step.uses ?? (step.run ?? "").trim().split("\n")[0]}`;

const declared = (step: WorkflowStep) => {
  const value = step.env?.["PUBLISHES"];
  return value === "yes" || value === "no" ? value : undefined;
};

const calledFile = (job: WorkflowJob) =>
  /^\.\/\.github\/workflows\/(.+)$/u.exec(job.uses ?? "")?.[1];

const jobIdIn = (ids: ReadonlyArray<string>, shown: string) =>
  ids
    .filter((id) => shown === id || shown.startsWith(`${id} `))
    .toSorted((a, b) => b.length - a.length)[0];

export interface RunJob {
  readonly name: string;
  readonly conclusion: string;
  readonly steps: ReadonlyArray<{ readonly name: string; readonly conclusion: string }>;
}

const settled = new Set(["success", "skipped", "neutral"]);

const runnerSteps = new Set(["Set up job", "Complete job", "Set up runner", "Complete runner"]);

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
