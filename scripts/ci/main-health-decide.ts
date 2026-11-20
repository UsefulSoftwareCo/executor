/* oxlint-disable no-control-regex -- terminal controls in log text are removed on purpose */
/**
 * What Main health does with the facts `main-health-read.ts` decoded: `decide`, a pure function
 * of the three sources' health and whether an owned issue is open, and `body`, the whole issue
 * text, a function of the facts alone. Nothing here reads GitHub or the clock.
 */

/**
 * One source's health. `bad`: positively known red, or a beta known to be held. `good`:
 * positively known green, or a beta known not to be held. `unknown`: no evidence either way (no
 * run that counts yet, no Beta decision in the window). A read that fails, or an answer that does
 * not decode, is none of these: the run stops before it gets here.
 */
export type Health = "bad" | "good" | "unknown";

/**
 * What a run does, from the three healths and whether an issue this script owns is open now (read
 * afresh on this run, not trusted from an earlier write):
 *
 * - `open`: something is bad and none is open: open one.
 * - `keep`: something is bad and one is open: write the lowest numbered, close any other.
 * - `close`: every source is good and one is open: close every one.
 * - `rewrite`: nothing is bad, something is unknown, and one is open: write each open one with
 *   the current facts, and open or close none.
 * - `none`: nothing to open, and nothing open: write nothing.
 *
 * Unknown never opens an issue and never closes one.
 */
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

/** A run of a workflow, as the issue names it. */
export interface RunRef {
  readonly id: number;
  readonly url: string;
  readonly sha: string;
}

/** A failed job of a red run: its log read for scenarios, gone from GitHub, or past `logsRead`. */
export interface FailedJob {
  readonly name: string;
  readonly url: string;
  readonly log: "read" | "gone" | "unread";
  readonly scenarios: ReadonlyArray<string>;
}

/** The commits from the last green run to the first red one, or GitHub unable to compare them. */
export interface Commits {
  readonly gone: boolean;
  readonly total: number;
  readonly commits: ReadonlyArray<{ readonly sha: string; readonly subject: string }>;
}

/** CI or the Windows check. `unknown` when the whole list was read and no run counts. */
export type WorkflowFact =
  | { readonly health: "unknown" }
  | { readonly health: "good"; readonly latest: RunRef }
  | {
      readonly health: "bad";
      readonly latest: RunRef;
      readonly first: RunRef;
      readonly green: RunRef | undefined;
      /** How many runs that count were read, for a red run with no green one before it. */
      readonly read: number;
      readonly jobs: ReadonlyArray<FailedJob>;
      readonly commits: Commits;
    };

/**
 * The held beta, from the newest Beta decision of the last six days. `unknown` when there is none:
 * `newest` is the newest one listed, older than that, or undefined when none is kept at all.
 */
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

/** How many failed jobs of a red run have their logs read for scenarios. */
export const logsRead = 20;
/** GitHub refuses a body over 65,536 characters; a longer one is cut at a line before this many bytes. */
const bodyLimit = 60000;

/**
 * Log text without terminal controls: CSI, OSC and the other string sequences (DCS, SOS, PM, APC)
 * opened by ESC or their one-byte C1 form and ended by BEL, ESC \ or ST in either form (or the
 * line), every other ESC sequence, the one-byte CSI and stray C0 and C1 controls, CR included; tab
 * and newline stay. Text that was not UTF-8 was decoded with U+FFFD in its place.
 */
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

/** Text from logs, job names, commits and the Beta tick, safe inside a code span: no control, no backtick ends it, no @ mentions. */
export const clean = (text: string) => stripControls(text).replace(/[`@]/gu, "");

interface Names {
  readonly marker: string;
  /** `https://github.com/OWNER/NAME`. */
  readonly repository: string;
  /** How the body names CI and the Windows check in a sentence. */
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
  // One code span, in which an @ mentions nobody, so the version names stay as they are.
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

/**
 * The issue's whole body, from the facts alone. One line per source comes first, so a body cut at
 * the limit still says what each one is; it is cut at a line, so a code span is never left open.
 */
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
