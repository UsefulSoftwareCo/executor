import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  clean,
  logsRead,
  stripControls,
  type BetaFact,
  type Commits,
  type FailedJob,
  type RunRef,
  type WorkflowFact,
} from "./main-health-decide.ts";

export class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", {
  message: Schema.String,
}) {}

export interface Source {
  readonly workflow: string;
  readonly branch: string;
  readonly event: string;
  readonly title?: string;
}

export interface Settings {
  readonly repository: string;
  /** `https://github.com`. */
  readonly server: string;
  readonly label: string;
  readonly marker: string;
  readonly ci: Source;
  readonly windows: Source;
  readonly beta: {
    readonly workflow: string;
    readonly branch: string;
    readonly artifact: string;
    readonly events: ReadonlyArray<string>;
  };
  readonly now: number;
  readonly temp: string;
}

const historyPages = 5;
const betaWindow = 6 * 24 * 60 * 60 * 1000;
const skew = 5 * 60 * 1000;
const sinceSkew = 60 * 1000;
const perPage = 100;
const stays = "The issue stays as it is until a run reads it.";

const failed = (message: string) => Effect.fail(new ReadFailed({ message }));

const RunStatus = Schema.Literals([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);
const RunConclusion = Schema.Literals([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);
const JobConclusion = Schema.Literals([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
]);
const ActorType = Schema.Literals([
  "User",
  "Bot",
  "Organization",
  "Mannequin",
  "EnterpriseUserAccount",
]);
const Id = Schema.Int.check(Schema.isGreaterThan(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

const schemas = (settings: Settings) => {
  const repository = `${settings.server}/${settings.repository}`;
  const Time = (allowed: number) =>
    Schema.String.check(
      Schema.isPattern(iso),
      Schema.makeFilter((value: string) =>
        Number.isNaN(Date.parse(value))
          ? `${value} is not a time`
          : Date.parse(value) <= settings.now + allowed || `${value} is in the future`,
      ),
    );
  const Stamp = Time(skew);
  const Run = (source: Source) =>
    Schema.Struct({
      id: Id,
      path: Schema.Literal(`.github/workflows/${source.workflow}`),
      event: Schema.Literal(source.event),
      head_branch: Schema.Literal(source.branch),
      status: RunStatus,
      conclusion: Schema.NullOr(RunConclusion),
      run_attempt: Id,
      created_at: Stamp,
      head_sha: Sha,
      html_url: Schema.String,
      display_title: Schema.String,
    }).check(
      Schema.makeFilter(
        (run) =>
          (run.status === "completed") === (run.conclusion !== null) ||
          `run ${run.id} is ${run.status} with conclusion ${run.conclusion}`,
      ),
      Schema.makeFilter(
        (run) =>
          run.html_url === `${repository}/actions/runs/${run.id}` ||
          `run ${run.id} names ${run.html_url} as its page`,
      ),
    );
  return {
    RunsPage: (source: Source) =>
      Schema.Struct({ total_count: Count, workflow_runs: Schema.Array(Run(source)) }),
    Attempt: (run: number, attempt: number) =>
      Schema.Struct({
        id: Schema.Literal(run),
        run_attempt: Schema.Literal(attempt),
        status: Schema.Literal("completed"),
        conclusion: RunConclusion,
      }),
    JobsPage: (run: number) =>
      Schema.Struct({
        total_count: Count,
        jobs: Schema.Array(
          Schema.Struct({
            id: Id,
            name: Schema.String,
            html_url: Schema.String,
            status: RunStatus,
            conclusion: Schema.NullOr(JobConclusion),
          }).check(
            Schema.makeFilter(
              (job) =>
                (job.status === "completed") === (job.conclusion !== null) ||
                `job ${job.id} is ${job.status} with conclusion ${job.conclusion}`,
            ),
            Schema.makeFilter(
              (job) =>
                job.html_url === `${repository}/actions/runs/${run}/job/${job.id}` ||
                `job ${job.id} names ${job.html_url} as its page`,
            ),
          ),
        ),
      }),
    Compare: Schema.Struct({
      total_commits: Count,
      commits: Schema.Array(
        Schema.Struct({ sha: Sha, commit: Schema.Struct({ message: Schema.String }) }),
      ),
    }).check(
      Schema.makeFilter(
        (compare) =>
          compare.commits.length === Math.min(compare.total_commits, 50) ||
          `${compare.commits.length} commits listed of ${compare.total_commits}`,
      ),
      Schema.makeFilter(
        (compare) =>
          new Set(compare.commits.map((commit) => commit.sha)).size === compare.commits.length ||
          "a commit is listed twice",
      ),
    ),
    ArtifactsPage: Schema.Struct({
      total_count: Count,
      artifacts: Schema.Array(
        Schema.Struct({
          id: Id,
          name: Schema.Literal(settings.beta.artifact),
          expired: Schema.Boolean,
          created_at: Stamp,
          workflow_run: Schema.Struct({
            id: Id,
            repository_id: Id,
            head_repository_id: Id,
            head_branch: Schema.String,
          }),
        }),
      ),
    }),
    Producer: (run: number) =>
      Schema.Struct({
        id: Schema.Literal(run),
        path: Schema.Literal(`.github/workflows/${settings.beta.workflow}`),
        event: Schema.Literals(settings.beta.events),
        head_branch: Schema.Literal(settings.beta.branch),
        status: RunStatus,
      }),
    Decision: Schema.Struct({
      state: Schema.Literals(["held", "clear"]),
      reason: Schema.String,
      since: Schema.Union([Schema.Literal(""), Time(sinceSkew)]),
      run: Schema.String.check(
        Schema.isPattern(new RegExp(`^${escaped(repository)}/actions/runs/[0-9]+$`, "u")),
      ),
    }),
    IssuesPage: Schema.Struct({
      errors: Schema.optionalKey(Schema.Never),
      data: Schema.Struct({
        repository: Schema.Struct({
          issues: Schema.Struct({
            totalCount: Count,
            pageInfo: Schema.Struct({
              hasNextPage: Schema.Boolean,
              endCursor: Schema.NullOr(Schema.String),
            }),
            nodes: Schema.Array(
              Schema.Struct({
                number: Id,
                title: Schema.String,
                body: Schema.String,
                author: Schema.NullOr(
                  Schema.Struct({ __typename: ActorType, login: Schema.String }),
                ),
                labels: Schema.Struct({
                  totalCount: Count,
                  nodes: Schema.Array(Schema.Struct({ name: Schema.String })),
                }),
              }).check(
                Schema.makeFilter(
                  (issue) =>
                    new Set(issue.labels.nodes.map((label) => label.name)).size ===
                      issue.labels.nodes.length || `#${issue.number} lists a label twice`,
                ),
                Schema.makeFilter(
                  (issue) =>
                    issue.labels.nodes.length === issue.labels.totalCount ||
                    `#${issue.number} lists ${issue.labels.nodes.length} of its ${issue.labels.totalCount} labels`,
                ),
              ),
            ),
          }),
        }),
      }),
    }),
    Label: Schema.Struct({ name: Schema.Literal(settings.label) }),
  };
};

const gh = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("gh", args, { stdout: "pipe", stderr: "pipe" }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkUint8Array(child.stdout),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr: stderr.trim(), exitCode: Number(exitCode) };
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => new ReadFailed({ message: `gh could not run: ${error.message}` })),
  );

const statusOf = (stderr: string) => Number(/\(HTTP (\d{3})\)/u.exec(stderr)?.[1] ?? 0);

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const answer = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* gh(["api", ...args]);
    if (result.exitCode !== 0)
      return yield* failed(`gh api ${args.join(" ")} failed: ${result.stderr}. ${stays}`);
    return result.stdout;
  });

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  bytes: Uint8Array,
  what: string,
  options?: { readonly onExcessProperty: "error" },
) =>
  Schema.decodeUnknownEffect(
    Schema.fromJsonString(schema),
    options,
  )(text(bytes)).pipe(
    Effect.mapError(
      (error) =>
        new ReadFailed({
          message: `${what} is not an answer this script reads: ${error.message}. ${stays}`,
        }),
    ),
  );

const checkPage = (
  what: string,
  page: number,
  count: number,
  total: number | undefined,
  ids: ReadonlyArray<number>,
  seen: Set<number>,
) =>
  Effect.gen(function* () {
    const expected = Math.max(Math.min(count - (page - 1) * perPage, perPage), 0);
    if ((total !== undefined && count !== total) || ids.length !== expected)
      return yield* failed(
        `Page ${page} of ${what} does not hold what its count says: ${JSON.stringify({ total_count: count, earlier: total ?? null, items: ids.length })}. The issue stays as it is until a run reads it whole.`,
      );
    for (const id of ids) {
      if (seen.has(id))
        return yield* failed(
          `Page ${page} of ${what} holds item ${id} twice, or an earlier page held it, so the list moved while it was read. The issue stays as it is until a run reads it whole.`,
        );
      seen.add(id);
    }
    return count;
  });

const readAll = <I extends { readonly id: number }>(
  path: string,
  page: (
    bytes: Uint8Array,
    what: string,
  ) => Effect.Effect<{ readonly count: number; readonly items: ReadonlyArray<I> }, ReadFailed>,
) =>
  Effect.gen(function* () {
    const items: Array<I> = [];
    const seen = new Set<number>();
    let total: number | undefined;
    for (let number = 1; ; number++) {
      const what = `Page ${number} of ${path}`;
      const read = yield* page(
        yield* answer([
          `${path}${path.includes("?") ? "&" : "?"}per_page=${perPage}&page=${number}`,
        ]),
        what,
      );
      total = yield* checkPage(
        path,
        number,
        read.count,
        total,
        read.items.map((item) => item.id),
        seen,
      );
      items.push(...read.items);
      if (number * perPage >= total) return items;
    }
  });

interface Decided extends RunRef {
  readonly createdAt: number;
  readonly attempt: number;
  readonly conclusion: string;
}

const isVoid = (conclusion: string) => conclusion === "cancelled" || conclusion === "skipped";

const byTime = (a: { readonly createdAt: number }, b: { readonly createdAt: number }) =>
  b.createdAt - a.createdAt;
const newestFirst = (a: Decided, b: Decided) => byTime(a, b) || b.id - a.id;

export const reads = (settings: Settings) => {
  const S = schemas(settings);
  const repo = `repos/${settings.repository}`;

  const decidingAttempt = (run: {
    readonly id: number;
    readonly status: string;
    readonly conclusion: string | null;
    readonly run_attempt: number;
    readonly created_at: string;
    readonly head_sha: string;
    readonly html_url: string;
  }) =>
    Effect.gen(function* () {
      const decided = (attempt: number, conclusion: string): Decided => ({
        id: run.id,
        url: run.html_url,
        sha: run.head_sha,
        createdAt: Date.parse(run.created_at),
        attempt,
        conclusion,
      });
      let hidden = false;
      if (run.status === "completed" && run.conclusion !== null) {
        if (!isVoid(run.conclusion)) return decided(run.run_attempt, run.conclusion);
        hidden = true;
      }
      for (let attempt = run.run_attempt - 1; attempt >= 1; attempt--) {
        const earlier = yield* decode(
          S.Attempt(run.id, attempt),
          yield* answer([`${repo}/actions/runs/${run.id}/attempts/${attempt}`]),
          `Attempt ${attempt} of run ${run.id}`,
        );
        if (isVoid(earlier.conclusion)) {
          hidden = true;
          continue;
        }
        if (hidden && earlier.conclusion === "success") return undefined;
        return decided(attempt, earlier.conclusion);
      }
      return undefined;
    });

  const failedJobs = (run: Decided) =>
    Effect.gen(function* () {
      const jobs = yield* readAll(
        `${repo}/actions/runs/${run.id}/attempts/${run.attempt}/jobs`,
        (bytes, what) =>
          decode(S.JobsPage(run.id), bytes, what).pipe(
            Effect.map((page) => ({ count: page.total_count, items: page.jobs })),
          ),
      );
      const out: Array<FailedJob> = [];
      for (const job of [...jobs]
        .sort((a, b) => a.id - b.id)
        .filter((each) => each.conclusion === "failure" || each.conclusion === "timed_out")) {
        const name = clean(job.name);
        if (out.length >= logsRead) {
          out.push({ name, url: job.html_url, log: "unread", scenarios: [] });
          continue;
        }
        const result = yield* gh([
          "api",
          "--allow-escape-sequences",
          `${repo}/actions/jobs/${job.id}/logs`,
        ]);
        if (result.exitCode !== 0) {
          if ([404, 410].includes(statusOf(result.stderr))) {
            out.push({ name, url: job.html_url, log: "gone", scenarios: [] });
            continue;
          }
          return yield* failed(
            `${result.stderr}\nThe log of ${job.html_url} could not be read, so the issue stays as it is until a run can read it.`,
          );
        }
        out.push({ name, url: job.html_url, log: "read", scenarios: scenarios(result.stdout) });
      }
      return out;
    });

  const commits = (green: RunRef, first: RunRef) =>
    Effect.gen(function* () {
      const path = `${repo}/compare/${green.sha}...${first.sha}?per_page=50&page=1`;
      const result = yield* gh(["api", path]);
      if (result.exitCode !== 0) {
        if (statusOf(result.stderr) === 404)
          return { gone: true, total: 0, commits: [] } satisfies Commits;
        return yield* failed(`gh api ${path} failed: ${result.stderr}. ${stays}`);
      }
      const compare = yield* decode(
        S.Compare,
        result.stdout,
        `The compare of ${green.sha}...${first.sha}`,
      );
      return {
        gone: false,
        total: compare.total_commits,
        commits: compare.commits.map((commit) => ({
          sha: commit.sha.slice(0, 9),
          subject: commit.commit.message.split("\n")[0]!,
        })),
      } satisfies Commits;
    });

  const workflow = (source: Source) =>
    Effect.gen(function* () {
      const path = `${repo}/actions/workflows/${source.workflow}/runs?branch=${source.branch}&event=${source.event}`;
      const decided: Array<Decided> = [];
      const seen = new Set<number>();
      let total: number | undefined;
      let previous: number | undefined;
      const latest = (): {
        readonly health: "none" | "green" | "red" | "open";
        readonly rests?: Decided;
      } => {
        const sorted = [...decided].sort(newestFirst);
        const newest = sorted[0];
        if (newest === undefined) return { health: "none" };
        if (newest.conclusion === "success") return { health: "green", rests: newest };
        const green = sorted.find((run) => run.conclusion === "success");
        return green === undefined
          ? { health: "open", rests: newest }
          : { health: "red", rests: green };
      };
      for (let page = 1; ; page++) {
        const runs = yield* decode(
          S.RunsPage(source),
          yield* answer([`${path}&per_page=${perPage}&page=${page}`]),
          `Page ${page} of ${path}`,
        );
        total = yield* checkPage(
          path,
          page,
          runs.total_count,
          total,
          runs.workflow_runs.map((run) => run.id),
          seen,
        );
        for (const run of runs.workflow_runs) {
          const created = Date.parse(run.created_at);
          if (previous !== undefined && byTime({ createdAt: previous }, { createdAt: created }) > 0)
            return yield* failed(
              `Page ${page} of ${path} lists run ${run.id} after an older one, so the list is not newest first. ${stays}`,
            );
          previous = created;
        }
        for (const run of runs.workflow_runs) {
          if (source.title !== undefined && run.display_title !== source.title) continue;
          if (run.status !== "completed" && run.run_attempt === 1) continue;
          const counted = yield* decidingAttempt(run);
          if (counted !== undefined) decided.push(counted);
        }
        if (page * perPage >= total) break;
        const state = latest();
        const whole = state.rests !== undefined && state.rests.createdAt > previous!;
        if ((state.health === "green" || state.health === "red") && whole) break;
        if (page === historyPages) {
          if (state.health === "none")
            return yield* failed(
              `None of the newest ${page * perPage} runs at ${path} counts yet, so what that workflow says is not known. The issue stays as it is.`,
            );
          if (!whole)
            return yield* failed(
              `Run ${state.rests!.id} at ${path} decides, but runs created at its time continue past the ${page * perPage} runs read, and one of them may rank above it. The issue stays as it is.`,
            );
          break;
        }
      }
      const sorted = decided.sort(newestFirst);
      const newest = sorted[0];
      if (newest === undefined) return { health: "unknown" } satisfies WorkflowFact;
      if (newest.conclusion === "success")
        return { health: "good", latest: ref(newest) } satisfies WorkflowFact;
      const greenAt = sorted.findIndex((run) => run.conclusion === "success");
      const green = greenAt === -1 ? undefined : sorted[greenAt]!;
      const first = greenAt === -1 ? sorted.at(-1)! : sorted[greenAt - 1]!;
      const jobs = yield* failedJobs(newest);
      return {
        health: "bad",
        latest: ref(newest),
        first: ref(first),
        green: green === undefined ? undefined : ref(green),
        read: sorted.length,
        jobs,
        commits:
          green === undefined
            ? { gone: false, total: 0, commits: [] }
            : yield* commits(green, first),
      } satisfies WorkflowFact;
    });

  const beta = Effect.gen(function* () {
    const path = `${repo}/actions/artifacts?name=${settings.beta.artifact}`;
    const artifacts = yield* readAll(path, (bytes, what) =>
      decode(S.ArtifactsPage, bytes, what).pipe(
        Effect.map((page) => ({ count: page.total_count, items: page.artifacts })),
      ),
    );
    const beta = artifacts
      .filter(
        (artifact) =>
          artifact.workflow_run.head_branch === settings.beta.branch &&
          artifact.workflow_run.head_repository_id === artifact.workflow_run.repository_id,
      )
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
    const counted = beta.filter(
      (artifact) => settings.now - Date.parse(artifact.created_at) <= betaWindow,
    );
    const newest = counted.at(-1);
    if (newest === undefined) {
      const old = beta.at(-1);
      return {
        health: "unknown",
        newest:
          old === undefined ? undefined : { createdAt: old.created_at, run: old.workflow_run.id },
      } satisfies BetaFact;
    }
    if (newest.expired)
      return yield* failed(
        `The newest ${settings.beta.artifact} artifact, ${newest.id} from ${newest.created_at}, has expired, so Beta's latest decision cannot be read; an older one does not stand in for it. The issue stays as it is.`,
      );
    yield* decode(
      S.Producer(newest.workflow_run.id),
      yield* answer([`${repo}/actions/runs/${newest.workflow_run.id}`]),
      `Run ${newest.workflow_run.id}, which uploaded artifact ${newest.id} (only ${settings.beta.workflow} on ${settings.beta.branch} uploads it),`,
    );
    const zip = yield* answer([
      "--allow-escape-sequences",
      `${repo}/actions/artifacts/${newest.id}/zip`,
    ]);
    const decision = yield* decode(
      S.Decision,
      yield* unzipped(zip, `${settings.beta.artifact}.json`, newest.id),
      `Artifact ${newest.id}, which does not hold one decision as ${settings.beta.workflow} writes it,`,
      { onExcessProperty: "error" },
    );
    return decision.state === "held"
      ? ({
          health: "bad",
          reason: decision.reason,
          since: decision.since,
          run: decision.run,
        } satisfies BetaFact)
      : ({ health: "good", run: decision.run } satisfies BetaFact);
  });

  const unzipped = (zip: Uint8Array, name: string, id: number) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${settings.temp}/artifact-${id}.zip`;
      yield* fs
        .writeFile(file, zip)
        .pipe(Effect.mapError((error) => new ReadFailed({ message: error.message })));
      const unzip = (args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* processes.spawn(
            ChildProcess.make("unzip", args, { stdout: "pipe", stderr: "pipe" }),
          );
          const [stdout, exitCode] = yield* Effect.all(
            [Stream.mkUint8Array(child.stdout), child.exitCode],
            {
              concurrency: "unbounded",
            },
          );
          return { stdout, exitCode: Number(exitCode) };
        }).pipe(
          Effect.scoped,
          Effect.mapError(
            (error) => new ReadFailed({ message: `unzip could not run: ${error.message}` }),
          ),
        );
      const listed = yield* unzip(["-Z1", file]);
      if (listed.exitCode !== 0 || text(listed.stdout).trim() !== name)
        return yield* failed(`Artifact ${id} holds other than the one file ${name}. ${stays}`);
      const content = yield* unzip(["-p", file, name]);
      if (content.exitCode !== 0)
        return yield* failed(`Artifact ${id}'s ${name} could not be read. ${stays}`);
      return content.stdout;
    });

  const owned = Effect.gen(function* () {
    const query = `query($owner: String!, $name: String!, $label: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, states: OPEN, labels: [$label], orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { number title body author { __typename login } labels(first: 100) { totalCount nodes { name } } }
    }
  }
}`;
    const [owner, name] = settings.repository.split("/") as [string, string];
    const issues: Array<{
      readonly number: number;
      readonly title: string;
      readonly body: string;
      readonly bot: boolean;
      readonly labelled: boolean;
    }> = [];
    const seen = new Set<number>();
    let total: number | undefined;
    let after: string | undefined;
    for (let page = 1; ; page++) {
      const what = `Page ${page} of the open issues labelled ${settings.label}`;
      const read = (yield* decode(
        S.IssuesPage,
        yield* answer([
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-f",
          `label=${settings.label}`,
          ...(after === undefined ? [] : ["-f", `after=${after}`]),
        ]),
        what,
      )).data.repository.issues;
      const before = issues.length;
      total = yield* checkPage(
        `the open issues labelled ${settings.label}`,
        page,
        read.totalCount,
        total,
        read.nodes.map((issue) => issue.number),
        seen,
      );
      const more = before + read.nodes.length < total;
      if (read.pageInfo.hasNextPage !== more || (more && read.pageInfo.endCursor === null))
        return yield* failed(
          `${what} says ${read.pageInfo.hasNextPage ? "more" : "no more"} follow, where its count says otherwise. ${stays}`,
        );
      for (const issue of read.nodes)
        issues.push({
          number: issue.number,
          title: issue.title,
          body: issue.body,
          bot: issue.author?.__typename === "Bot" && issue.author.login === "github-actions",
          labelled: issue.labels.nodes.some((label) => label.name === settings.label),
        });
      if (!more) break;
      after = read.pageInfo.endCursor!;
    }
    return issues
      .filter((issue) => issue.bot && issue.labelled && issue.body.includes(settings.marker))
      .sort((a, b) => a.number - b.number)
      .map(({ number, title, body }) => ({ number, title, body }));
  });

  const labelExists = Effect.gen(function* () {
    const result = yield* gh(["api", `${repo}/labels/${settings.label}`]);
    if (result.exitCode !== 0) {
      if (statusOf(result.stderr) === 404) return false;
      return yield* failed(
        `gh api ${repo}/labels/${settings.label} failed: ${result.stderr}. Nothing was written.`,
      );
    }
    yield* decode(S.Label, result.stdout, `The label ${settings.label}`);
    return true;
  });

  return {
    ci: workflow(settings.ci),
    windows: workflow(settings.windows),
    beta,
    owned,
    labelExists,
  };
};

const ref = (run: Decided): RunRef => ({ id: run.id, url: run.url, sha: run.sha });

const scenarios = (bytes: Uint8Array) => {
  const lines = stripControls(
    text(bytes)
      .split("\n")
      .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z ?/u, ""))
      .join("\n"),
  ).split("\n");
  const found = (marker: RegExp, strip: (line: string) => string) =>
    [...new Set(lines.filter((line) => marker.test(line)).map((line) => clean(strip(line))))]
      .sort()
      .slice(0, 20);
  const summary = found(/^\s*FAIL\s+.*\.(spec|test)\.[cm]?[jt]sx? > /u, (line) =>
    line.replace(/^\s*FAIL\s+/u, ""),
  );
  if (summary.length > 0) return summary;
  return found(/^\s*[×✗]\s+.*\.(spec|test)\.[cm]?[jt]sx? > /u, (line) =>
    line.replace(/^\s*[×✗]\s+/u, "").replace(/\s+[0-9]+ms$/u, ""),
  );
};
