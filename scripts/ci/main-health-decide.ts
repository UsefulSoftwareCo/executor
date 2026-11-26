/* oxlint-disable no-control-regex -- terminal controls in log text are removed on purpose */

export type Health = "bad" | "good" | "unknown";

export type Outcome = "open" | "keep" | "close" | "rewrite" | "none";

export const decide = (
  health: { readonly ci: Health; readonly windows: Health; readonly beta: Health },
  open: boolean,
): Outcome => {
  const all = [health.ci, health.windows, health.beta];
  if (all.includes("bad")) return open ? "keep" : "open";
  if (all.every((each) => each === "good")) return open ? "close" : "none";
  return open ? "rewrite" : "none";
};

export interface RunRef {
  readonly id: number;
  readonly url: string;
  readonly sha: string;
}

export interface FailedJob {
  readonly name: string;
  readonly url: string;
  readonly log: "read" | "gone" | "unread";
  readonly scenarios: ReadonlyArray<string>;
}

export interface Commits {
  readonly gone: boolean;
  readonly total: number;
  readonly commits: ReadonlyArray<{ readonly sha: string; readonly subject: string }>;
}

export type WorkflowFact =
  | { readonly health: "unknown" }
  | { readonly health: "good"; readonly latest: RunRef }
  | {
      readonly health: "bad";
      readonly latest: RunRef;
      readonly first: RunRef;
      readonly green: RunRef | undefined;
      readonly read: number;
      readonly jobs: ReadonlyArray<FailedJob>;
      readonly commits: Commits;
    };

export type BetaFact =
  | {
      readonly health: "bad";
      readonly reason: string;
      readonly since: string;
      readonly run: string;
    }
  | { readonly health: "good"; readonly run: string }
  | {
      readonly health: "unknown";
      readonly newest: { readonly createdAt: string; readonly run: number } | undefined;
    };

export interface Facts {
  readonly ci: WorkflowFact;
  readonly windows: WorkflowFact;
  readonly beta: BetaFact;
}

export const logsRead = 20;
const bodyLimit = 60000;

export const stripControls = (text: string) =>
  text
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c\n]*(?:\u0007|\u001b\\|\u009c)?/gu, "")
    .replace(
      /(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[^\u001b\u009c\n]*(?:\u001b\\|\u009c)?/gu,
      "",
    )
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[ -/]*[0-~]?/gu, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");

export const clean = (text: string) => stripControls(text).replace(/[`@]/gu, "");

interface Names {
  readonly marker: string;
  /** `https://github.com/OWNER/NAME`. */
  readonly repository: string;
  readonly ci: string;
  readonly windows: string;
  readonly betaWorkflow: string;
  readonly betaArtifact: string;
}

const statusLine = (who: string, fact: WorkflowFact) =>
  fact.health === "bad"
    ? `- ${who}: red`
    : fact.health === "good"
      ? `- ${who}: green`
      : `- ${who}: unknown, no finished run that counts`;

const section = (heading: string, who: string, fact: WorkflowFact, repository: string) => {
  const lines = [`## ${heading}`, ""];
  if (fact.health === "unknown")
    lines.push(
      `Unknown: no finished run of ${who} counts yet, so whether it is red cannot be read. Unknown neither opens nor closes this issue.`,
    );
  else if (fact.health === "good") lines.push(`Green: ${fact.latest.url} on ${fact.latest.sha}.`);
  else {
    lines.push(
      "Red. Fix the cause: do not re-run or revert to get it green.",
      "",
      `- Latest failure: ${fact.latest.url} on ${fact.latest.sha}`,
      `- First failure: ${fact.first.url} on ${fact.first.sha}`,
    );
    if (fact.green !== undefined) {
      lines.push(
        `- Last green run before it: ${fact.green.url} on ${fact.green.sha}. The first failure came from a commit in ${repository}/compare/${fact.green.sha}...${fact.first.sha}`,
      );
      const listed = fact.commits.commits.length;
      if (fact.commits.gone)
        lines.push(
          "",
          "GitHub cannot compare those two commits (HTTP 404), so they are not listed.",
        );
      else if (listed > 0)
        lines.push(
          "",
          fact.commits.total > listed
            ? `The first ${listed} of ${fact.commits.total} commits since the last green run, oldest first:`
            : "Commits since the last green run, oldest first:",
          "",
          ...fact.commits.commits.map((commit) => `- ${clean(`${commit.sha} ${commit.subject}`)}`),
        );
    } else lines.push(`- No earlier green run: ${fact.read} finished runs read, none passed.`);
    lines.push("", "Failed jobs in the latest failure:", "");
    if (fact.jobs.length === 0) lines.push("- No failed job listed; see the run.");
    for (const job of fact.jobs) {
      lines.push(`- [${job.name}](${job.url})`);
      if (job.log === "gone") lines.push("  - GitHub no longer has its log; see the job.");
      else if (job.log === "unread")
        lines.push(`  - More than ${logsRead} jobs failed, so its log was not read; see the job.`);
      else if (job.scenarios.length === 0)
        lines.push("  - No failed scenario in its log; see the job's failed step.");
      else lines.push(...job.scenarios.map((scenario) => `  - \`${scenario}\``));
    }
  }
  lines.push("");
  return lines;
};

const betaLines = (beta: BetaFact, names: Names) => {
  if (beta.health === "unknown")
    return [
      `Unknown: no Beta tick in the last six days left a decision (the ${names.betaArtifact} artifact ${names.betaWorkflow} uploads when it decides held or clear, kept for seven days)${
        beta.newest === undefined
          ? ", and none is kept at all"
          : `; the newest, from ${beta.newest.createdAt} by ${names.repository}/actions/runs/${beta.newest.run}, is older than that`
      }. So whether a beta is held cannot be read, and unknown neither opens nor closes this issue.`,
    ];
  if (beta.health === "good")
    return [
      `Not held: the latest Beta tick that decided, ${beta.run}, found it on npm with nothing holding the next.`,
    ];
  const since = clean(beta.since);
  const reason = stripControls(`${beta.reason}\n`)
    .replace(/`/gu, "")
    .replace(/\n/gu, " ")
    .replace(/ $/u, "");
  return [
    since === ""
      ? `Held. A beta is due and is not out; when it became due could not be read. The latest Beta tick that decided, ${beta.run}, held it:`
      : `Held. A beta has been due since ${since} and is not out. The latest Beta tick that decided, ${beta.run}, held it:`,
    "",
    `> \`${reason}\``,
  ];
};

export const body = (facts: Facts, names: Names) => {
  const unknown = [
    ...(facts.ci.health === "unknown" ? ["CI on main"] : []),
    ...(facts.windows.health === "unknown" ? ["the Windows check"] : []),
    ...(facts.beta.health === "unknown" ? ["the beta release"] : []),
  ];
  const bad = [facts.ci.health, facts.windows.health, facts.beta.health].includes("bad");
  const lines = [
    names.marker,
    "Main health (scripts/ci/main-health.ts) writes this issue whole from what it reads: CI on main, the paced Windows check and the Beta tick's last decision on a held beta. It opens it when one of them is red or held, closes it when each is known to be green or not held, and while none is red or held but one is unknown, leaves it open or closed as it was. Edits to it are overwritten.",
    "",
    statusLine("CI on main", facts.ci),
    statusLine("The Windows check", facts.windows),
    facts.beta.health === "bad"
      ? "- The beta release: held"
      : facts.beta.health === "good"
        ? "- The beta release: not held"
        : "- The beta release: unknown, no Beta decision in the last six days could be read",
    "",
    ...(!bad && unknown.length > 0
      ? [
          `Nothing is known to be red or held. ${unknown.join(" and ").replace(/^./u, (first) => first.toUpperCase())} cannot be read (below), so this issue stays as it was: Main health neither opens nor closes it on what it cannot read, and closes it once every source is known to be green or not held.`,
          "",
        ]
      : []),
    ...section("CI on main", names.ci, facts.ci, names.repository),
    ...section("The Windows check", names.windows, facts.windows, names.repository),
    "## The beta release",
    "",
    ...betaLines(facts.beta, names),
  ];
  const kept: Array<string> = [];
  let size = 0;
  let cut = false;
  for (const line of lines) {
    size += new TextEncoder().encode(line).length + 1;
    if (size > bodyLimit) {
      cut = true;
      break;
    }
    kept.push(line);
  }
  if (cut) kept.push("", "(Cut here: GitHub keeps at most 65,536 characters. See the runs above.)");
  return kept.join("\n").replace(/\n+$/u, "");
};
