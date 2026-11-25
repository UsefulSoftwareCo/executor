import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as skipCheck from "../ci-skip-check.ts";

interface Upload {
  readonly bytes: number;
  readonly budget?: number;
  readonly sources?: Readonly<Record<string, number>>;
  readonly staticBytes?: number;
}

const main: Readonly<Record<string, Upload>> = {
  api: { bytes: 5_400_000, budget: 6_000_000 },
  dashboard: { bytes: 3_900_000, budget: 4_300_000 },
};

const description = (...lines: ReadonlyArray<string>) =>
  ["Adds a sign-in method.", "", "```worker-growth", ...lines, "```", ""].join("\n");

const check = (input: {
  readonly uploads: Readonly<Record<string, Upload>>;
  readonly base?: Readonly<Record<string, Upload>> | "missing";
  readonly description?: string;
  readonly merged?: ReadonlyArray<{ readonly number: number; readonly body: string }>;
  readonly baseline?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-worker-sizes-" });
    const write = (name: string, uploads: Readonly<Record<string, Upload>>) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(directory, name));
        for (const [worker, upload] of Object.entries(uploads))
          yield* fs.writeFileString(
            path.join(directory, name, `${worker}.json`),
            JSON.stringify({
              worker,
              bytes: upload.bytes,
              budget: upload.budget ?? 10_000_000,
              ...(upload.staticBytes === undefined ? {} : { staticBytes: upload.staticBytes }),
              sources: upload.sources ?? { [`apps/hosted/cloud/src/${worker}.ts`]: upload.bytes },
            }),
          );
      });
    yield* write("uploads", input.uploads);
    if (input.base !== "missing") yield* write("base", input.base ?? main);
    const summary = path.join(directory, "summary");
    yield* fs.writeFileString(summary, "");
    if (input.description !== undefined)
      yield* fs.writeFileString(path.join(directory, "description"), input.description);
    if (input.merged !== undefined)
      yield* fs.writeFileString(path.join(directory, "merged"), JSON.stringify(input.merged));
    const child = yield* processes.spawn(
      ChildProcess.make(
        "bun",
        [
          "apps/hosted/cloud/scripts/worker-sizes.ts",
          "--uploads",
          path.join(directory, "uploads"),
          "--base",
          path.join(directory, "base"),
          ...(input.description === undefined
            ? []
            : ["--description", path.join(directory, "description")]),
          ...(input.merged === undefined ? [] : ["--merged", path.join(directory, "merged")]),
          ...(input.baseline === undefined ? [] : ["--baseline", input.baseline]),
        ],
        { env: { GITHUB_STEP_SUMMARY: summary }, extendEnv: true },
      ),
    );
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return {
      exitCode,
      errors: log.split("\n").filter((line) => line.startsWith("::error ")),
      log,
      summary: yield* fs.readFileString(summary),
    };
  }).pipe(Effect.scoped);

layer(NodeServices.layer, { excludeTestServices: true })("Worker upload growth", (it) => {
  it.effect("a pull request that adds 50,000 bytes to a Worker needs no allowance", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: { ...main, api: { bytes: 5_450_000, budget: 6_000_000 } },
        description: "Adds a sign-in method.",
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.summary).toContain("| api | 5,450,000 | +50,000 | 6,000,000 |");
      expect(result.summary).not.toContain("worker-growth");
    }),
  );

  it.effect("one byte more fails, and the summary gives the line the description needs", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: {
          ...main,
          api: {
            bytes: 5_450_001,
            budget: 6_000_000,
            sources: {
              "apps/hosted/cloud/src/api.ts": 5_400_000,
              "node_modules/.bun/saml@1.0.0/node_modules/saml/index.js": 50_001,
            },
          },
        },
        description: "Adds a sign-in method.",
      });
      expect(result.exitCode, result.log).toBe(1);
      expect(result.errors).toEqual([
        expect.stringMatching(
          /^::error title=api Worker grew without an allowance::\+50,001 bytes over main, about 2 ms on each cold start; a pull request may add 50,000\./u,
        ),
      ]);
      expect(result.summary).toContain("| api | 5,450,001 | +50,001 **needs an allowance** |");
      expect(result.summary).toContain("```worker-growth\napi +50,001:\n```");
      expect(result.summary).toContain("| `saml` | +50,001 |");
      expect(result.summary).toContain("| dashboard | 3,900,000 | 0 |");
    }),
  );

  it.effect(
    "the error gives the line to add, and that line passes once its reason replaces the placeholder",
    () =>
      Effect.gen(function* () {
        const uploads = { ...main, api: { bytes: 5_450_001, budget: 6_000_000 } };
        const line = "api +50,001: <why it is worth the cold-start time>";
        const failed = yield* check({ uploads, description: "Adds a sign-in method." });
        expect(failed.exitCode, failed.log).toBe(1);
        expect(failed.errors).toEqual([
          expect.stringContaining(
            `Trim it, or allow it: put the line \`${line}\` in a worker-growth block of the pull request description, with your reason in place of <why it is worth the cold-start time>, then run this job again.`,
          ),
        ]);
        expect(failed.log).toContain(`\`\`\`worker-growth\n${line}\n\`\`\``);
        const pasted = yield* check({ uploads, description: description(line) });
        expect(pasted.exitCode, pasted.log).toBe(1);
        expect(pasted.summary).toContain(
          `- \`${line}\` is not a Worker, a size and a reason (write the real reason in place of <why it is worth the cold-start time>)`,
        );
        const reasoned = yield* check({
          uploads,
          description: description(
            "api +50,001: the SAML library, which every enterprise sign-in loads",
          ),
        });
        expect(reasoned.exitCode, reasoned.log).toBe(0);
        const bracketed = yield* check({
          uploads,
          description: description("api +50,001: <Suspense> around <Editor>"),
        });
        expect(bracketed.exitCode, bracketed.log).toBe(0);
      }),
  );

  it.effect("an allowance for at least what the Worker adds passes and shows its reason", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: {
          api: { bytes: 5_520_000, budget: 6_000_000 },
          dashboard: { bytes: 4_000_000, budget: 4_300_000 },
        },
        description: description(
          "api +120,000: the SAML library, which every enterprise sign-in loads",
          "dashboard 100000: the chart on the usage page",
        ),
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.summary).toContain(
        "- api: +120,000 bytes, about 5 ms. Allowed up to 120,000: the SAML library, which every enterprise sign-in loads",
      );
      expect(result.summary).toContain(
        "- dashboard: +100,000 bytes, about 4 ms. Allowed up to 100,000: the chart on the usage page",
      );
    }),
  );

  it.effect("an allowance smaller than what the Worker adds fails for that Worker only", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: {
          api: { bytes: 5_520_000, budget: 6_000_000 },
          dashboard: { bytes: 4_000_000, budget: 4_300_000 },
        },
        description: description(
          "api +119,999: the SAML library",
          "dashboard +100,000: the chart on the usage page",
        ),
      });
      expect(result.exitCode, result.log).toBe(1);
      expect(result.errors).toEqual([
        expect.stringContaining(
          "title=api Worker grew without an allowance::+120,000 bytes over main, about 5 ms on each cold start; the description allows 119,999.",
        ),
      ]);
      expect(result.summary).toContain("```worker-growth\napi +120,000:\n```");
    }),
  );

  it.effect("an allowance needs a reason, a size and a Worker the check builds", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: { ...main, api: { bytes: 5_520_000, budget: 6_000_000 } },
        description: description(
          "api +120,000:",
          "dashboard: it grew",
          "gateway +10,000: there is no such Worker",
        ),
      });
      expect(result.exitCode, result.log).toBe(1);
      expect(result.errors).toEqual([
        expect.stringContaining("title=api Worker grew without an allowance"),
      ]);
      expect(result.summary).toContain("- `api +120,000:` is not a Worker, a size and a reason");
      expect(result.summary).toContain(
        "- `dashboard: it grew` is not a Worker, a size and a reason",
      );
      expect(result.summary).toContain("- `gateway` is not a Worker this check builds");
    }),
  );

  it.effect("a line the check cannot read fails a pull request that grew nothing", () =>
    Effect.gen(function* () {
      const result = yield* check({ uploads: main, description: description("api: in case") });
      expect(result.exitCode, result.log).toBe(1);
      expect(result.summary).toContain("- `api: in case` is not a Worker, a size and a reason");
    }),
  );

  it.effect("a push to main reports growth without failing", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: { ...main, api: { bytes: 5_520_000, budget: 6_000_000 } },
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.summary).toContain("| api | 5,520,000 | +120,000 | 6,000,000 |");
      expect(result.summary).toContain("- api: +120,000 bytes, about 5 ms.");
    }),
  );

  it.effect(
    "without main's sizes the pull request passes and the summary says growth went unchecked",
    () =>
      Effect.gen(function* () {
        const result = yield* check({
          uploads: { ...main, api: { bytes: 5_900_000, budget: 6_000_000 } },
          base: "missing",
          description: "Adds a sign-in method.",
        });
        expect(result.exitCode, result.log).toBe(0);
        expect(result.summary).toContain(
          "The sizes of main were not available, so no change is shown and growth is not checked.",
        );
        expect(result.summary).toContain("| api | 5,900,000 | n/a | 6,000,000 |");
      }),
  );

  it.effect("a Worker main does not have is held to its budget alone", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: { ...main, search: { bytes: 900_000, budget: 1_000_000 } },
        description: "Adds a search Worker.",
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.summary).toContain("| search | 900,000 | n/a | 1,000,000 |");
    }),
  );

  it.effect("a Worker over its budget fails whatever the description allows", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: { ...main, api: { bytes: 6_000_001, budget: 6_000_000 } },
        description: description("api +700,000: a new sign-in method"),
      });
      expect(result.exitCode, result.log).toBe(1);
      expect(result.errors).toEqual([
        expect.stringContaining("title=api Worker over its upload budget::6,000,001 bytes"),
      ]);
      expect(result.summary).toContain("-1 (-0.0%) **over budget**");
    }),
  );

  it.effect("a budget that differs from main's is shown beside main's", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: { ...main, api: { bytes: 5_400_000, budget: 6_500_000 } },
        description: "Raises the API Worker's budget.",
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.summary).toContain("| api | 5,400,000 | 0 | 6,500,000 (main: 6,000,000) |");
      expect(result.summary).toContain("| dashboard | 3,900,000 | 0 | 4,300,000 |");
    }),
  );
});

const lazyDashboard: Readonly<Record<string, Upload>> = {
  dashboard: { bytes: 3_900_000, budget: 4_300_000, staticBytes: 240_000 },
};

layer(NodeServices.layer, { excludeTestServices: true })("Worker static imports", (it) => {
  it.effect(
    "an entry that imports 50,001 more bytes statically fails though its upload is the same",
    () =>
      Effect.gen(function* () {
        const result = yield* check({
          uploads: { dashboard: { ...lazyDashboard.dashboard!, staticBytes: 290_001 } },
          base: lazyDashboard,
          description: "Shares Effect between the dashboard and its renderer.",
        });
        expect(result.exitCode, result.log).toBe(1);
        expect(result.errors).toEqual([
          expect.stringContaining(
            "title=dashboard Worker grew without an allowance::+50,001 bytes of static imports over main",
          ),
        ]);
        expect(result.summary).toContain("| dashboard | 290,001 | +50,001 |");
        expect(result.summary).toContain("```worker-growth\ndashboard +50,001:\n```");
      }),
  );

  it.effect(
    "pulling the dashboard renderer back into the entry fails though the upload grows 1,904 bytes",
    () =>
      Effect.gen(function* () {
        const result = yield* check({
          uploads: { dashboard: { bytes: 3_778_051, budget: 4_300_000, staticBytes: 3_778_051 } },
          base: { dashboard: { bytes: 3_776_147, budget: 4_300_000, staticBytes: 394_571 } },
          description: "Shares Effect between the dashboard and its renderer.",
        });
        expect(result.exitCode, result.log).toBe(1);
        expect(result.errors).toEqual([
          expect.stringContaining(
            "title=dashboard Worker grew without an allowance::+3,383,480 bytes of static imports over main",
          ),
        ]);
        expect(result.summary).toContain(
          "| dashboard | 3,778,051 | +1,904 **needs an allowance** | 4,300,000 |",
        );
        expect(result.summary).toContain("| dashboard | 3,778,051 | +3,383,480 |");
      }),
  );

  it.effect("50,000 more bytes of static imports need no allowance", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: { dashboard: { ...lazyDashboard.dashboard!, staticBytes: 290_000 } },
        base: lazyDashboard,
        description: "Imports a small helper at startup.",
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.summary).toContain("| dashboard | 290,000 | +50,000 |");
    }),
  );

  it.effect("a worker-growth line allows static imports as it allows an upload", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: { dashboard: { ...lazyDashboard.dashboard!, staticBytes: 3_780_000 } },
        base: lazyDashboard,
        description: description(
          "dashboard +3,540,000: the renderer, which every dashboard isolate loads on its first render",
        ),
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.summary).toContain(
        "- dashboard: +3,540,000 bytes of static imports, about 142 ms. Allowed up to 3,540,000",
      );
    }),
  );

  it.effect("main's uploads from before static imports were recorded show no change", () =>
    Effect.gen(function* () {
      const result = yield* check({
        uploads: { dashboard: { ...lazyDashboard.dashboard!, staticBytes: 3_780_000 } },
        base: { dashboard: { bytes: 3_900_000, budget: 4_300_000 } },
        description: "Shares Effect between the dashboard and its renderer.",
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.summary).toContain("| dashboard | 3,780,000 | n/a |");
    }),
  );
});

interface Upper {
  readonly number: number;
  readonly headRefOid: string;
  readonly isCrossRepository?: boolean;
  readonly isDraft?: boolean;
}

interface StubRecord {
  readonly id?: number;
  readonly name: string;
  readonly text: string;
  readonly after?: number;
}

interface GitHubAnswers {
  readonly open?: Readonly<
    Record<string, ReadonlyArray<{ baseRefName: string; isCrossRepository?: boolean }>>
  >;
  readonly merge?: Readonly<Record<string, string>>;
  readonly runs?: Readonly<Record<string, string>>;
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly downloads?: Readonly<Record<string, Readonly<Record<string, Upload>>>>;
  readonly builtFrom?: Readonly<Record<string, string | null>>;
  readonly runSources?: Readonly<
    Record<string, { path?: string; event?: string; repository?: string | null }>
  >;
  readonly uppers?: ReadonlyArray<Upper>;
  readonly upperSnapshots?: ReadonlyArray<ReadonlyArray<Upper>>;
  readonly upperRuns?: Readonly<
    Record<
      string,
      ReadonlyArray<{
        id: number;
        path?: string;
        status?: string;
        conclusion?: string | null;
        repository?: string;
      }>
    >
  >;
  readonly records?: Readonly<Record<string, StubRecord | ReadonlyArray<StubRecord>>>;
  readonly otherArtifacts?: Readonly<Record<string, ReadonlyArray<{ id: number; name: string }>>>;
  readonly selectJobs?: Readonly<Record<string, { status: string; waitingAbove?: boolean }>>;
  readonly runJobs?: Readonly<
    Record<string, ReadonlyArray<{ name: string; status: string; conclusion?: string | null }>>
  >;
  readonly matrixJobs?: Readonly<Record<string, number>>;
  readonly failPullRequests?: boolean;
  readonly failCompare?: ReadonlyArray<string>;
  readonly contains?: Readonly<Record<string, string>>;
  readonly flaky?: Readonly<Record<string, number>>;
  readonly pushCommits?: ReadonlyArray<string>;
  readonly commitPulls?: Readonly<Record<string, ReadonlyArray<number>>>;
  readonly pullBodies?: Readonly<Record<string, string>>;
  readonly failPush?: boolean;
  readonly hangs?: Readonly<Record<string, number>>;
  readonly slow?: Readonly<Record<string, number>>;
  readonly commits?: Readonly<
    Record<
      string,
      {
        message: string;
        author: string;
        parents: ReadonlyArray<string>;
        files: ReadonlyArray<{ name: string; patch: string | null }>;
      }
    >
  >;
}

const stubGh = `#!/usr/bin/env bun
const fs = require("node:fs");
const path = require("node:path");
const answers = JSON.parse(fs.readFileSync(path.join(__dirname, "answers.json"), "utf8"));
const args = process.argv.slice(2);
const command = args.join(" ");
fs.appendFileSync(path.join(__dirname, "calls"), command + "\\n");
const value = (flag) => args[args.indexOf(flag) + 1];
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(1); };
// A call whose text contains a key of \`hangs\` never answers, that many times.
for (const [part, times] of Object.entries(answers.hangs || {})) {
  if (!command.includes(part)) continue;
  const count = path.join(__dirname, "hang-" + Buffer.from(part).toString("hex"));
  const hung = fs.existsSync(count) ? Number(fs.readFileSync(count, "utf8")) : 0;
  if (hung < times) { fs.writeFileSync(count, String(hung + 1)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
}
// A call whose text contains a key of \`slow\` answers that many milliseconds late.
for (const [part, ms] of Object.entries(answers.slow || {}))
  if (command.includes(part)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// A call whose text contains a key of \`flaky\` fails, as GitHub does for a moment, that many times.
for (const [part, times] of Object.entries(answers.flaky || {})) {
  if (!command.includes(part)) continue;
  const count = path.join(__dirname, "flaky-" + Buffer.from(part).toString("hex"));
  const failed = fs.existsSync(count) ? Number(fs.readFileSync(count, "utf8")) : 0;
  if (failed < times) { fs.writeFileSync(count, String(failed + 1)); fail("gh: Server Error (HTTP 502)"); }
}
const calls = (part) => fs.readFileSync(path.join(__dirname, "calls"), "utf8").split("\\n").filter((call) => call.includes(part)).length;
// A conditional REST read (\`gh api -i\`): an ETag of the body, and a 304, on which gh exits 1, when
// it is the one the caller sent.
const reply = (body) => {
  const text = JSON.stringify(body);
  const etag = 'W/"' + require("node:crypto").createHash("sha1").update(text).digest("hex") + '"';
  const sent = args.includes("-H") ? value("-H").replace(/^If-None-Match: /, "") : undefined;
  if (sent === etag) { process.stdout.write("HTTP/2.0 304 Not Modified\\r\\nEtag: " + etag + "\\r\\n\\r\\n"); process.exit(1); }
  process.stdout.write("HTTP/2.0 200 OK\\r\\nEtag: " + etag + "\\r\\n\\r\\n" + text);
};
const at = (list, part) => list[Math.min(calls(part), list.length) - 1];
const pathArg = args.find((arg) => arg.startsWith("repos/")) || "";
if (args[0] === "pr" && args[1] === "list") {
  if (answers.failPullRequests) fail("gh: Server Error (HTTP 502)");
  const open = (answers.open || {})[value("--head")] || [];
  process.stdout.write(JSON.stringify(open.map((pull) => ({ isCrossRepository: false, ...pull }))));
} else if (args[0] === "api" && args[1] === "rate_limit") {
  process.stdout.write("core 120 used of 1000, 880 left; graphql 0 used of 1000");
} else if (args[0] === "api" && /\\/pulls\\?base=/.test(pathArg)) {
  if (answers.failPullRequests) fail("gh: Server Error (HTTP 502)");
  const uppers = answers.upperSnapshots ? at(answers.upperSnapshots, "/pulls?base=") : answers.uppers || [];
  reply(uppers.map((pull) => ({ number: pull.number, draft: pull.isDraft === true, head: { sha: pull.headRefOid, repo: { full_name: pull.isCrossRepository ? "someone/fork" : "owner/repository" } } })));
} else if (args[0] === "api" && /\\/actions\\/runs\\?/.test(pathArg)) {
  const headSha = pathArg.replace(/^.*head_sha=/, "").replace(/&.*$/, "");
  const runs = ((answers.upperRuns || {})[headSha] || []).map((run) => ({ path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", html_url: "https://github.com/owner/repository/actions/runs/" + run.id, head_repository: { full_name: run.repository || "owner/repository" }, ...run }));
  reply({ workflow_runs: runs });
} else if (args[0] === "api" && /\\/actions\\/runs\\/\\d+\\/artifacts/.test(pathArg)) {
  const run = pathArg.replace(/^.*\\/runs\\//, "").replace(/\\/.*$/, "");
  const reads = calls("/runs/" + run + "/artifacts");
  const listed = [].concat((answers.records || {})[run] || []).filter((record) => reads > (record.after || 0));
  // As GitHub lists them: newest first (the records, uploaded by select, are the oldest), 100 a
  // page, with the run's count.
  const page = Number((pathArg.match(/[?&]page=(\\d+)/) || [])[1] || 1);
  const all = [...((answers.otherArtifacts || {})[run] || []), ...listed.map((record, index) => ({ id: record.id || Number(run) * 10 + index, name: record.name }))];
  reply({ total_count: all.length, artifacts: all.slice((page - 1) * 100, page * 100) });
} else if (args[0] === "api" && /\\/actions\\/runs\\/\\d+\\/jobs/.test(pathArg)) {
  const run = pathArg.replace(/^.*\\/runs\\//, "").replace(/\\/.*$/, "");
  const select = (answers.selectJobs || {})[run] || { status: "in_progress" };
  // A page of at most 100, as GitHub lists them, with the run's count of jobs.
  const page = Number((pathArg.match(/[?&]page=(\\d+)/) || [])[1] || 1);
  const matrix = Array.from({ length: (answers.matrixJobs || {})[run] || 0 }, (_, index) => ({ name: "checks / e2e-self-host (" + (index + 1) + ")", status: "completed", conclusion: "success" }));
  const all = [{ name: "checks / select", status: select.status, steps: [{ name: "Check that the layer above was computed on this layer", status: select.waitingAbove ? "in_progress" : "pending" }] }, ...matrix, ...((answers.runJobs || {})[run] || [])];
  reply({ total_count: all.length, jobs: all.slice((page - 1) * 100, page * 100) });
} else if (args[0] === "api" && /\\/compare\\//.test(args[1]) && value("--jq") === ".status") {
  const pair = args[1].replace(/^.*\\/compare\\//, "").replace(/\\?.*$/, "");
  const status = (answers.contains || {})[pair];
  if (status === undefined) fail("gh: Not Found (HTTP 404)");
  if (status === "fail") fail("gh: Server Error (HTTP 502)");
  process.stdout.write(status + "\\n");
} else if (args[0] === "api" && /\\/compare\\//.test(args[1]) && value("--jq") === "[.commits[].sha]") {
  if (answers.failPush) fail("gh: Server Error (HTTP 502)");
  process.stdout.write(JSON.stringify(answers.pushCommits || []));
} else if (args[0] === "api" && /\\/commits\\/[0-9a-f]+\\/pulls$/.test(args[1])) {
  const commit = args[1].replace(/^.*\\/commits\\//, "").replace(/\\/pulls$/, "");
  process.stdout.write(JSON.stringify((answers.commitPulls || {})[commit] || []));
} else if (args[0] === "api" && /\\/pulls\\/\\d+$/.test(args[1])) {
  const number = args[1].replace(/^.*\\/pulls\\//, "");
  const body = (answers.pullBodies || {})[number];
  if (body === undefined) fail("gh: Not Found (HTTP 404)");
  process.stdout.write(body);
} else if (args[0] === "api" && /\\/compare\\//.test(args[1])) {
  const branch = decodeURIComponent(args[1].replace(/^.*\\/compare\\//, "").replace(/\\.\\.\\..*$/, ""));
  if ((answers.failCompare || []).includes(branch)) fail("gh: Server Error (HTTP 503)");
  const sha = (answers.merge || {})[branch];
  if (sha === undefined) fail("gh: Not Found (HTTP 404)");
  process.stdout.write(sha);
} else if (args[0] === "run" && args[1] === "list") {
  // Only main's own push runs are answered: a pull request's run can name main as its branch.
  process.stdout.write(value("--event") === "push" ? (answers.runs || {})[value("--commit")] || "" : "");
} else if (args[0] === "api" && /\\/actions\\/artifacts\\?name=/.test(args[1])) {
  const name = args[1].replace(/^.*name=/, "").replace(/&.*$/, "");
  process.stdout.write((answers.artifacts || {})[name] || "[]");
} else if (args[0] === "api" && /\\/actions\\/runs\\/\\d+$/.test(args[1])) {
  const source = (answers.runSources || {})[args[1].replace(/^.*\\/runs\\//, "")];
  process.stdout.write(JSON.stringify({ path: ".github/workflows/ci.yml", event: "pull_request", repository: "owner/repository", ...source }));
} else if (args[0] === "api" && /\\/commits\\/[0-9a-f]+$/.test(args[1])) {
  const info = (answers.commits || {})[args[1].replace(/^.*\\/commits\\//, "")];
  if (info === undefined) fail("gh: Not Found (HTTP 404)");
  process.stdout.write(JSON.stringify(info));
} else if (args[0] === "run" && args[1] === "download") {
  const name = value("--name");
  fs.mkdirSync(value("--dir"), { recursive: true });
  if (name.startsWith("ci-tested-")) {
    const record = Object.values(answers.records || {}).flat().find((each) => each.name === name);
    if (record === undefined) fail("no artifact matches");
    fs.writeFileSync(path.join(value("--dir"), "record"), record.text);
    process.exit(0);
  }
  const uploads = (answers.downloads || {})[name];
  if (uploads === undefined) fail("no artifact matches");
  for (const [worker, upload] of Object.entries(uploads))
    fs.writeFileSync(path.join(value("--dir"), worker + ".json"), JSON.stringify({ worker, budget: 10000000, sources: {}, ...upload }));
  // A recorded build names the commit it was built from, unless \`builtFrom\` says otherwise.
  const built = name.startsWith("worker-uploads-at-") ? ((answers.builtFrom || {})[name] === undefined ? name.slice("worker-uploads-at-".length) : answers.builtFrom[name]) : name === "worker-build" ? ((answers.builtFrom || {})[name] ?? null) : null;
  if (built !== null) fs.writeFileSync(path.join(value("--dir"), name === "worker-build" ? "built-from.txt" : "baseline-commit.txt"), built + "\\n");
} else fail("unexpected gh " + command);
`;

const baseline = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  answers: GitHubAnswers = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-worker-baseline-" });
    const bin = path.join(directory, "bin");
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, "gh"), stubGh);
    yield* fs.chmod(path.join(bin, "gh"), 0o755);
    yield* fs.writeFileString(path.join(bin, "answers.json"), JSON.stringify(answers));
    yield* fs.writeFileString(path.join(bin, "calls"), "");
    const output = path.join(directory, "output");
    yield* fs.writeFileString(output, "");
    const sizes = path.join(directory, "sizes");
    const file = path.join(directory, "merged.json");
    const child = yield* processes.spawn(
      ChildProcess.make(
        "node",
        [
          "scripts/ci/worker-baseline.ts",
          ...command.map((arg) => (arg === "<sizes>" ? sizes : arg === "<file>" ? file : arg)),
        ],
        {
          env: {
            PATH: `${bin}:${process.env["PATH"] ?? ""}`,
            GITHUB_REPOSITORY: "owner/repository",
            DEFAULT_BRANCH: "main",
            GITHUB_OUTPUT: output,
            RUNNER_TEMP: directory,
            WORKER_BASELINE_RETRY_SECONDS: "0.01",
            ...env,
          },
          extendEnv: true,
        },
      ),
    );
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    const outputs = Object.fromEntries(
      (yield* fs.readFileString(output))
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return {
      exitCode: Number(exitCode),
      log,
      outputs,
      calls: (yield* fs.readFileString(path.join(bin, "calls"))).split("\n").filter(Boolean),
      sizes: (yield* fs.exists(sizes)) ? yield* fs.readDirectory(sizes) : [],
      file: (yield* fs.exists(file)) ? yield* fs.readFileString(file) : undefined,
    };
  }).pipe(Effect.scoped);

const sha = (character: string) => character.repeat(40);

const releaseFiles = (version: string) => {
  const before = `2.0.0-beta.${Number(version) - 1}`;
  const after = `2.0.0-beta.${version}`;
  return [
    {
      name: "apps/cli/CHANGELOG.md",
      patch: `@@ -1,3 +1,9 @@\n # executor\n \n+## ${after}\n+`,
    },
    {
      name: "apps/cli/package.json",
      patch: `@@ -1,6 +1,6 @@\n {\n   "name": "executor",\n-  "version": "${before}",\n+  "version": "${after}",\n   "private": true,\n   "description": "Run Executor locally and connect your agents to your apps.",\n   "homepage": "https://executor.sh",`,
    },
    {
      name: "bun.lock",
      patch: `@@ -40,7 +40,7 @@\n     },\n     "apps/cli": {\n       "name": "executor",\n-      "version": "${before}",\n+      "version": "${after}",\n     },\n     "apps/docs": {\n       "name": "@executor-js/docs",`,
    },
  ];
};
const head = sha("f");

layer(NodeServices.layer, { excludeTestServices: true })("Worker size baseline", (it) => {
  it.effect("a stack that ends on main is compared with main, as before", () =>
    Effect.gen(function* () {
      const onMain = yield* baseline(["resolve"], {
        BASE_REF: "main",
        BASE_SHA: sha("1"),
        HEAD_SHA: head,
      });
      expect(onMain.outputs).toMatchObject({
        branch: "main",
        commit: sha("1"),
        id: `main@${sha("1")}`,
      });
      expect(onMain.calls).toEqual([]);
      const push = yield* baseline(["resolve"], { BASE_REF: "", BASE_SHA: sha("2") });
      expect(push.outputs).toMatchObject({ branch: "main", commit: sha("2") });
      const layered = yield* baseline(
        ["resolve"],
        { BASE_REF: "layer-2", BASE_SHA: sha("3"), HEAD_SHA: head },
        {
          open: { "layer-2": [{ baseRefName: "layer-1" }], "layer-1": [{ baseRefName: "main" }] },
          merge: { main: sha("4") },
        },
      );
      expect(layered.exitCode, layered.log).toBe(0);
      expect(layered.outputs).toMatchObject({ branch: "main", commit: sha("4"), note: "" });
    }),
  );

  it.effect(
    "a stack that ends on another branch is compared with that branch at its merge base",
    () =>
      Effect.gen(function* () {
        const answers: GitHubAnswers = {
          open: { "eapps-layer": [{ baseRefName: "effect-apps" }] },
          merge: { "effect-apps": sha("5"), main: sha("6") },
        };
        for (const base of ["effect-apps", "eapps-layer"]) {
          const run = yield* baseline(
            ["resolve"],
            { BASE_REF: base, BASE_SHA: sha("7"), HEAD_SHA: head },
            answers,
          );
          expect(run.exitCode, run.log).toBe(0);
          expect(run.outputs, base).toMatchObject({
            branch: "effect-apps",
            commit: sha("5"),
            id: `effect-apps@${sha("5")}`,
            label: "effect-apps at 555555555",
          });
        }
        const merge = yield* baseline(
          ["resolve"],
          { BASE_REF: "main", BASE_SHA: sha("8"), HEAD_SHA: head },
          answers,
        );
        expect(merge.outputs).toMatchObject({ branch: "main", commit: sha("8") });
        const fork = yield* baseline(
          ["resolve"],
          { BASE_REF: "effect-apps", BASE_SHA: sha("7"), HEAD_SHA: head },
          {
            ...answers,
            open: { "effect-apps": [{ baseRefName: "main", isCrossRepository: true }] },
          },
        );
        expect(fork.outputs).toMatchObject({ branch: "effect-apps" });
      }),
  );

  it.effect("whatever cannot be read, or could end on main, is compared with main", () =>
    Effect.gen(function* () {
      const env = { BASE_REF: "effect-apps", BASE_SHA: sha("7"), HEAD_SHA: head };
      const gone = yield* baseline(["resolve"], env, { merge: { main: sha("6") } });
      expect(gone.exitCode, gone.log).toBe(0);
      expect(gone.outputs).toMatchObject({ branch: "main", commit: sha("6") });
      expect(gone.outputs.note).toContain("effect-apps could not be read");
      const unlisted = yield* baseline(
        ["resolve"],
        { ...env, BASE_REF: "eapps-layer" },
        {
          failPullRequests: true,
          merge: { main: sha("6"), "effect-apps": sha("5") },
        },
      );
      expect(unlisted.outputs).toMatchObject({ branch: "main", commit: sha("6") });
      expect(unlisted.outputs.note).toContain("could not be read");
      const both = yield* baseline(
        ["resolve"],
        { ...env, BASE_REF: "shared" },
        {
          open: { shared: [{ baseRefName: "effect-apps" }, { baseRefName: "main" }] },
          merge: { main: sha("6"), "effect-apps": sha("5") },
        },
      );
      expect(both.outputs).toMatchObject({ branch: "main", commit: sha("6") });
      const two = yield* baseline(
        ["resolve"],
        { ...env, BASE_REF: "shared" },
        {
          open: { shared: [{ baseRefName: "effect-apps" }, { baseRefName: "other-branch" }] },
          merge: { main: sha("6"), "effect-apps": sha("5"), "other-branch": sha("4") },
        },
      );
      expect(two.outputs).toMatchObject({ branch: "main", commit: sha("6") });
      const forced = yield* baseline(["resolve", "--main"], env, {
        merge: { main: sha("6"), "effect-apps": sha("5") },
      });
      expect(forced.outputs).toMatchObject({ branch: "main", commit: sha("6") });
    }),
  );

  it.effect(
    "a branch's sizes come from a recorded build of that commit, else a build, else main's",
    () =>
      Effect.gen(function* () {
        const branch = { BASELINE_BRANCH: "effect-apps", BASELINE_COMMIT: sha("5") };
        const name = `worker-uploads-at-${sha("5")}`;
        const recorded = yield* baseline(["fetch", "<sizes>"], branch, {
          artifacts: { [name]: JSON.stringify([{ expired: false, run: 77 }]) },
          downloads: { [name]: { api: { bytes: 5_500_000 } } },
        });
        expect(recorded.outputs).toEqual({
          found: "true",
          build: "false",
          label: "effect-apps at 555555555",
        });
        expect(recorded.sizes.toSorted()).toEqual(["api.json", "baseline-commit.txt"]);
        for (const artifacts of [{}, { [name]: JSON.stringify([{ expired: true, run: 76 }]) }]) {
          const missing = yield* baseline(["fetch", "<sizes>"], branch, {
            artifacts,
            downloads: { [name]: { api: { bytes: 5_500_000 } } },
          });
          expect(missing.outputs).toMatchObject({ found: "false", build: "true" });
          expect(missing.sizes).toEqual([]);
        }
        const main = yield* baseline(
          ["fetch", "<sizes>"],
          { BASELINE_BRANCH: "main", BASELINE_COMMIT: sha("6") },
          {
            runs: { [sha("6")]: "88" },
            downloads: { "worker-uploads": { api: { bytes: 5_400_000 } } },
            artifacts: {
              [`worker-uploads-at-${sha("6")}`]: JSON.stringify([{ expired: false, run: 99 }]),
            },
          },
        );
        expect(main.outputs).toMatchObject({
          found: "true",
          build: "false",
          label: "main at 666666666",
        });
        expect(main.calls.some((call) => call.includes("actions/artifacts"))).toBe(false);
        const fallback = yield* baseline(
          ["fallback", "<sizes>"],
          { BASE_REF: "effect-apps", BASE_SHA: sha("7"), HEAD_SHA: head },
          {
            merge: { main: sha("6") },
            runs: { [sha("6")]: "88" },
            downloads: { "worker-uploads": { api: { bytes: 5_400_000 } } },
          },
        );
        expect(fallback.outputs).toMatchObject({ branch: "main", commit: sha("6"), found: "true" });
        expect(fallback.sizes).toEqual(["api.json"]);
      }),
  );

  it.effect(
    "a release commit has no sizes of its own, so main's are those of the nearest commit before it that has them",
    () =>
      Effect.gen(function* () {
        const release = (version: string, parent: string) => ({
          message: `Release 2.0.0-beta.${version} [skip ci]`,
          author: "github-actions[bot]",
          parents: [parent],
          files: releaseFiles(version),
        });
        const sizes = { "worker-uploads": { api: { bytes: 5_400_000 } } };
        const at = (commit: string) => ({ BASELINE_BRANCH: "main", BASELINE_COMMIT: commit });
        const one = yield* baseline(["fetch", "<sizes>"], at(sha("a")), {
          commits: { [sha("a")]: release("54", sha("b")) },
          runs: { [sha("b")]: "88" },
          downloads: sizes,
        });
        expect(one.outputs).toMatchObject({ found: "true", label: "main at bbbbbbbbb" });
        expect(one.log).toContain(
          `main's sizes for ${sha("a")} are those of ${sha("b")}, the nearest earlier commit with sizes: ${sha("a")} is a release commit, which changes no Worker.`,
        );
        const two = yield* baseline(["fetch", "<sizes>"], at(sha("a")), {
          commits: { [sha("a")]: release("54", sha("c")), [sha("c")]: release("53", sha("b")) },
          runs: { [sha("b")]: "88" },
          downloads: sizes,
        });
        expect(two.outputs).toMatchObject({ found: "true", label: "main at bbbbbbbbb" });
        const files = releaseFiles("54");
        const changed = (name: string, patch: string | null) =>
          files.map((file) => (file.name === name ? { name, patch } : file));
        for (const other of [
          {
            ...release("54", sha("b")),
            files: [
              ...files,
              { name: "apps/hosted/cloud/src/api.ts", patch: "@@ -1 +1 @@\n-a\n+b" },
            ],
          },
          { ...release("54", sha("b")), author: "someone" },
          { ...release("54", sha("b")), message: "Fix the API [skip ci]" },
          { ...release("54", sha("b")), message: 'Revert "Release 2.0.0-beta.54 [skip ci]"' },
          { ...release("54", sha("b")), parents: [sha("b"), sha("c")] },
          { ...release("54", sha("b")), files: [] },
          {
            ...release("54", sha("b")),
            files: changed(
              "bun.lock",
              `${files[2]!.patch}\n@@ -900,7 +900,7 @@\n     "effect": ["effect@4.1.4", "", {}, "sha512-a"],\n-    "hono": ["hono@4.9.0", "", {}, "sha512-b"],\n+    "hono": ["hono@4.9.1", "", {}, "sha512-c"],`,
            ),
          },
          {
            ...release("54", sha("b")),
            files: changed(
              "bun.lock",
              files[2]!.patch!.replace('"apps/cli": {', '"apps/hosted/cloud": {'),
            ),
          },
          {
            ...release("54", sha("b")),
            files: changed(
              "apps/cli/package.json",
              files[1]!.patch!.replace(
                '   "private": true,',
                '-  "private": true,\n+  "dependencies": { "effect": "4.2.0" },',
              ),
            ),
          },
          { ...release("54", sha("b")), files: changed("bun.lock", null) },
        ]) {
          const stopped = yield* baseline(["fetch", "<sizes>"], at(sha("a")), {
            commits: { [sha("a")]: other },
            runs: { [sha("b")]: "88" },
            downloads: sizes,
          });
          expect(stopped.outputs, JSON.stringify(other)).toMatchObject({
            found: "false",
            label: "main at aaaaaaaaa",
          });
          expect(stopped.log).toContain(
            `main's sizes for ${sha("a")} are not available yet, so no change is shown.`,
          );
        }
        const chain = Object.fromEntries(
          ["a", "c", "d", "e", "1", "2"].map((name, index, names) => [
            sha(name),
            release(String(54 - index), sha(names[index + 1] ?? "b")),
          ]),
        );
        const far = yield* baseline(["fetch", "<sizes>"], at(sha("a")), {
          commits: chain,
          runs: { [sha("b")]: "88" },
          downloads: sizes,
        });
        expect(far.outputs).toMatchObject({ found: "false" });
        expect(far.log).toContain(
          `main's sizes for ${sha("a")} are not available yet, nor for the release commits before it (`,
        );
        expect(far.calls.filter((call) => call.includes("/commits/"))).toHaveLength(5);
      }),
  );

  const effectApps = [
    {
      pull: 4552,
      base: "1179b8ca4265c1732417025f940ffbc157ba29fe",
      head: "8bac4152b92066961b76ff939971213a4f44a9d7",
    },
    {
      pull: 4549,
      base: "25fee749c5b43a26f15db7e19f6b6cf7fd5a1b16",
      head: "dae54b308c893385ab6467395665265514f55f7e",
    },
    {
      pull: 4538,
      base: "72546a2ddc63bed6f2787772228104e4a106559c",
      head: "d65f5aac1c4c08a9933f896bf9e71f47d856bda2",
    },
  ];
  const branchSizes = {
    "mcp-server": { bytes: 3_520_000, budget: 3_700_000 },
    api: { bytes: 5_355_000, budget: 6_000_000 },
    "app-pages": { bytes: 2_578_000, budget: 2_700_000 },
    "app-data": { bytes: 723_000, budget: 750_000 },
  };
  const mainSizes = {
    "mcp-server": { bytes: 3_379_000, budget: 3_700_000 },
    api: { bytes: 5_234_000, budget: 6_000_000 },
    "app-pages": { bytes: 2_460_000, budget: 2_700_000 },
    "app-data": { bytes: 664_000, budget: 750_000 },
  };

  it.effect(
    "the effect-apps pull requests that added nothing need no allowance against their branch",
    () =>
      Effect.gen(function* () {
        for (const { pull, base, head: commit } of effectApps) {
          const resolved = yield* baseline(
            ["resolve"],
            { BASE_REF: "effect-apps", BASE_SHA: base, HEAD_SHA: commit },
            { merge: { "effect-apps": base, main: sha("6") } },
          );
          expect(resolved.outputs, `#${pull}`).toMatchObject({
            branch: "effect-apps",
            commit: base,
          });
          const own = yield* check({
            uploads: branchSizes,
            base: branchSizes,
            description: "No worker-growth block.",
            baseline: resolved.outputs.label!,
          });
          expect(own.exitCode, `#${pull}: ${own.log}`).toBe(0);
          const before = yield* check({
            uploads: branchSizes,
            base: mainSizes,
            description: "No worker-growth block.",
          });
          expect(before.exitCode, `#${pull}`).toBe(1);
        }
      }),
  );

  it.effect(
    "growth of a pull request's own still fails, named against its baseline, and budgets hold off main",
    () =>
      Effect.gen(function* () {
        const v1 = yield* check({
          uploads: { ...main, api: { bytes: 5_460_000, budget: 6_000_000 } },
          description: "Serves v1's MCP URLs.",
          baseline: "main at 3f59c3bb0",
        });
        expect(v1.exitCode).toBe(1);
        expect(v1.errors).toEqual([
          expect.stringContaining(
            "::error title=api Worker grew without an allowance::+60,000 bytes over main at 3f59c3bb0",
          ),
        ]);
        const grown = yield* check({
          uploads: { ...branchSizes, api: { bytes: 5_405_001, budget: 6_000_000 } },
          base: branchSizes,
          description: "Adds a route.",
          baseline: "effect-apps at 555555555",
        });
        expect(grown.exitCode).toBe(1);
        expect(grown.errors).toEqual([
          expect.stringContaining("+50,001 bytes over effect-apps at 555555555"),
        ]);
        expect(grown.summary).toContain("Change from effect-apps at 555555555");
        const merge = yield* check({
          uploads: branchSizes,
          base: mainSizes,
          description: "Merges apps 1.x.",
          baseline: "main at 3f59c3bb0",
        });
        expect(merge.exitCode).toBe(1);
        expect(merge.errors.join("\n")).toContain("+141,000 bytes over main at 3f59c3bb0");
        const over = yield* check({
          uploads: { ...branchSizes, api: { bytes: 6_000_001, budget: 6_000_000 } },
          base: { ...branchSizes, api: { bytes: 6_000_001, budget: 6_000_000 } },
          description: "No growth.",
          baseline: "effect-apps at 555555555",
        });
        expect(over.exitCode).toBe(1);
        expect(over.errors).toEqual([
          expect.stringContaining("title=api Worker over its upload budget"),
        ]);
      }),
  );

  it.effect(
    "a run is never repeated across baselines, and a missing branch build falls back to main",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checks = yield* fs.readFileString(".github/workflows/checks.yml");
        expect(checks).toContain(
          'sized=$(node e2e/ci-key.ts record "$tree" "$base" sized "$WORKER_GROWTH" "$BASELINE")',
        );
        expect(checks).toContain(
          'node e2e/ci-key.ts record "$tree" "$base" sized "$growth" "$BASELINE"',
        );
        expect(checks).toContain(
          "BASELINE: ${{ steps.main-baseline.outputs.id || steps.baseline.outputs.id }}",
        );
        expect(checks).toContain(
          'key=$(node e2e/ci-key.ts record "$tree" "$base" "$SELECTION" "$WORKER_GROWTH")',
        );
        expect(checks).toContain(
          "if: steps.baseline-sizes.outputs.build == 'true' && steps.baseline-build.outcome != 'success'",
        );
        expect(checks).toContain(
          "node scripts/ci/worker-baseline.ts fallback .local/worker-uploads-base",
        );
        expect(checks).toContain(`--baseline "$BASELINE"`);
      }),
  );

  it.effect(
    "sizes are used only from a source this repository's own code wrote, for the commit asked for",
    () =>
      Effect.gen(function* () {
        const main = yield* baseline(
          ["fetch", "<sizes>"],
          { BASELINE_BRANCH: "main", BASELINE_COMMIT: sha("6") },
          { runs: { [sha("6")]: "88" }, downloads: { "worker-uploads": { api: { bytes: 1 } } } },
        );
        expect(main.outputs).toMatchObject({ found: "true" });
        expect(main.calls.find((call) => call.startsWith("run list"))).toContain("--event push");
        const branch = { BASELINE_BRANCH: "effect-apps", BASELINE_COMMIT: sha("5") };
        const name = `worker-uploads-at-${sha("5")}`;
        const recorded = {
          artifacts: { [name]: JSON.stringify([{ expired: false, run: 77 }]) },
          downloads: { [name]: { api: { bytes: 5_500_000 } } },
        };
        const own = yield* baseline(["fetch", "<sizes>"], branch, recorded);
        expect(own.outputs).toMatchObject({ found: "true", build: "false" });
        expect(own.sizes.toSorted()).toEqual(["api.json", "baseline-commit.txt"]);
        for (const [why, answers] of [
          ["a fork's run", { runSources: { "77": { repository: "someone/fork" } } }],
          ["another workflow's run", { runSources: { "77": { path: ".github/workflows/x.yml" } } }],
          ["a push run", { runSources: { "77": { event: "push" } } }],
          ["sizes built from another commit", { builtFrom: { [name]: sha("4") } }],
          ["sizes that name no commit", { builtFrom: { [name]: null } }],
        ] as const) {
          const refused = yield* baseline(["fetch", "<sizes>"], branch, {
            ...recorded,
            ...answers,
          });
          expect(refused.outputs, why).toMatchObject({ found: "false", build: "true" });
          expect(refused.sizes, why).toEqual([]);
        }
        const second = yield* baseline(["fetch", "<sizes>"], branch, {
          ...recorded,
          artifacts: {
            [name]: JSON.stringify([
              { expired: false, run: 78 },
              { expired: false, run: 77 },
            ]),
          },
          runSources: { "78": { repository: "someone/fork" } },
        });
        expect(second.outputs).toMatchObject({ found: "true" });
        expect(second.calls).toContain(
          `run download 77 --repo owner/repository --name ${name} --dir ${second.calls.find((call) => call.startsWith("run download"))!.split(" --dir ")[1]}`,
        );
        expect(second.calls.some((call) => call.startsWith("run download 78"))).toBe(false);
      }),
  );

  it.effect(
    "a read that fails for a moment is tried again, and a stack that still cannot be read is compared with main",
    () =>
      Effect.gen(function* () {
        const env = { BASE_REF: "eapps-layer", BASE_SHA: sha("7"), HEAD_SHA: head };
        const answers: GitHubAnswers = {
          open: { "eapps-layer": [{ baseRefName: "effect-apps" }] },
          merge: { "effect-apps": sha("5"), main: sha("6") },
        };
        const flaky = yield* baseline(["resolve"], env, {
          ...answers,
          flaky: { "pr list": 2, "compare/effect-apps": 2 },
        });
        expect(flaky.exitCode, flaky.log).toBe(0);
        expect(flaky.outputs).toMatchObject({ branch: "effect-apps", commit: sha("5"), note: "" });
        expect(flaky.calls.filter((call) => call.startsWith("pr list"))).toHaveLength(4);
        const down = yield* baseline(["resolve"], env, { ...answers, failPullRequests: true });
        expect(down.exitCode, down.log).toBe(0);
        expect(down.outputs).toMatchObject({ branch: "main", commit: sha("6") });
        expect(down.log).toContain(
          "::notice title=Worker sizes::the stack below eapps-layer could not be read, so this compares with main.",
        );
        expect(down.calls.filter((call) => call.startsWith("pr list"))).toHaveLength(4);
        const blind = yield* baseline(["resolve"], env, {
          ...answers,
          failPullRequests: true,
          failCompare: ["main"],
        });
        expect(blind.exitCode, blind.log).toBe(0);
        expect(blind.outputs).toMatchObject({
          branch: "main",
          commit: "",
          id: "main@unread",
          label: "main",
        });
        expect(blind.log).toContain("so no change is shown");
        const gone = yield* baseline(
          ["resolve"],
          { ...env, BASE_REF: "effect-apps" },
          {
            merge: { main: sha("6") },
          },
        );
        expect(gone.calls.filter((call) => call.includes("compare/effect-apps"))).toHaveLength(1);
        const sizes = yield* baseline(
          ["fetch", "<sizes>"],
          { BASELINE_BRANCH: "main", BASELINE_COMMIT: sha("6") },
          {
            runs: { [sha("6")]: "88" },
            downloads: { "worker-uploads": { api: { bytes: 1 } } },
            flaky: { "run list": 1 },
          },
        );
        expect(sizes.outputs).toMatchObject({ found: "true" });
      }),
  );

  const lowerHead = sha("c");
  const skipLayer = (bottom = "main", ready = false) => ({
    HEAD_REF: "lower",
    HEAD_SHA: lowerHead,
    BASELINE_BRANCH: bottom,
    GITHUB_RUN_ID: "500",
    SKIP_ABOVE_TIME_SCALE: "0",
    LOWER_DRAFT: ready ? "false" : "true",
  });
  const upperHead = sha("d");
  const record = (base: string, baseline: string, format = "2", tested?: string) =>
    `${format === "" ? "" : `format ${format}\n`}pull request 11\nmerge tree ${sha("e")}\nbase ${base}\n${tested === undefined ? "" : `tested ${tested}\n`}selection x\nworker-growth y\nbaseline ${baseline}\nabove none\n`;
  const good = record(lowerHead, `main@${sha("6")}`);
  const laundered = record(lowerHead, `effect-apps@${sha("5")}`);
  const upper = (text: string, more: GitHubAnswers = {}): GitHubAnswers => ({
    uppers: [{ number: 11, headRefOid: upperHead }],
    upperRuns: { [upperHead]: [{ id: 600 }] },
    records: { "600": { name: "ci-tested-pr11-key", text } },
    ...more,
  });
  const decided = (log: string) =>
    JSON.parse(log.match(/^skip-check (\{.*\})$/m)?.[1] ?? "null") as {
      mode: string;
      decision: string;
      oldFormat: boolean;
      rule: string;
      waited: number;
      reason: string;
      message: string;
    } | null;

  it.effect(
    "a ready skip layer passes only on a ready layer's green merge gate above, and fails the step otherwise",
    () =>
      Effect.gen(function* () {
        const gated = (gate: string, above = "none") =>
          `format 4\npull request 11\nmerge tree ${sha("e")}\nbase ${lowerHead}\ntested ${sha("e")}\nselection x\nworker-growth y\nbaseline main@${sha("6")}\nabove ${above}\ngate ${gate}\n`;
        const jobs = (check: string | null, e2e: string | null) => ({
          runJobs: {
            "600": [
              {
                name: "checks / check",
                status: check === null ? "in_progress" : "completed",
                conclusion: check,
              },
              {
                name: "checks / e2e",
                status: e2e === null ? "queued" : "completed",
                conclusion: e2e,
              },
            ],
          },
        });
        const ready = skipLayer("main", true);
        const oldFormats = [
          record(lowerHead, `main@${sha("6")}`, ""),
          record(lowerHead, `main@${sha("6")}`, "3", sha("e")),
        ] as const;
        const runs = yield* Effect.all(
          {
            running: baseline(["above"], ready, upper(gated("full"), jobs(null, null))),
            green: baseline(["above"], ready, upper(gated("full"), jobs("success", "success"))),
            narrowed: baseline(
              ["above"],
              ready,
              upper(gated("narrowed"), jobs("success", "success")),
            ),
            draft: baseline(["above"], ready, upper(gated("draft"), jobs("success", "success"))),
            red: baseline(["above"], ready, upper(gated("full"), jobs("success", "failure"))),
            oldUnformatted: baseline(
              ["above"],
              ready,
              upper(oldFormats[0], jobs("success", "success")),
            ),
            oldFormat3: baseline(
              ["above"],
              ready,
              upper(oldFormats[1], jobs("success", "success")),
            ),
            stacked: baseline(["above"], ready, upper(gated("stack", "pass"))),
            stackedFailed: baseline(["above"], ready, upper(gated("stack", "fail"))),
            moved: baseline(
              ["above"],
              ready,
              upper(gated("full").replace(`base ${lowerHead}`, `base ${sha("b")}`), {
                ...jobs("success", "success"),
                contains: { [`${lowerHead}...${sha("e")}`]: "diverged" },
              }),
            ),
            observed: baseline(
              ["above"],
              skipLayer(),
              upper(gated("draft"), jobs("success", "success")),
            ),
            draftAgain: baseline(["above"], ready, {
              ...upper(gated("full"), jobs("success", "success")),
              uppers: [{ number: 11, headRefOid: upperHead, isDraft: true }],
            }),
            stackedDraft: baseline(["above"], ready, {
              ...upper(gated("stack", "pass")),
              uppers: [{ number: 11, headRefOid: upperHead, isDraft: true }],
            }),
            paged: baseline(["above"], ready, {
              ...upper(gated("full"), jobs("success", "success")),
              matrixJobs: { "600": 120 },
            }),
            pagedRed: baseline(["above"], ready, {
              ...upper(gated("full"), jobs("success", "failure")),
              matrixJobs: { "600": 230 },
            }),
          },
          { concurrency: 4 },
        );
        const green = runs.green;
        expect(green.exitCode, green.log).toBe(0);
        expect(decided(green.log)).toMatchObject({
          mode: "enforce",
          decision: "pass",
          rule: "gate",
        });
        expect(green.outputs.decision).toBe("pass");
        const narrowed = runs.narrowed;
        expect(narrowed.exitCode, narrowed.log).toBe(0);
        const draft = runs.draft;
        expect(draft.exitCode).not.toBe(0);
        expect(decided(draft.log)).toMatchObject({ mode: "enforce", decision: "fail" });
        expect(decided(draft.log)!.reason).toContain(
          "is a draft's, which runs only its block's selection",
        );
        expect(decided(draft.log)!.message).toContain("mark #11 ready for review (gh pr ready 11)");
        const red = runs.red;
        expect(red.exitCode).not.toBe(0);
        expect(decided(red.log)!.reason).toContain(
          "ended with checks / check success and checks / e2e failure",
        );
        const running = runs.running;
        expect(running.exitCode).not.toBe(0);
        expect(running.log).toContain("runs the full suite for a merge and has not finished");
        expect(decided(running.log)!.waited).toBeGreaterThanOrEqual(skipCheck.bounds.testing);
        for (const [text, old] of [
          [oldFormats[0], runs.oldUnformatted],
          [oldFormats[1], runs.oldFormat3],
        ] as const) {
          expect(old.exitCode, text).not.toBe(0);
          expect(decided(old.log)!.reason).toContain("recorded no merge gate");
        }
        const stacked = runs.stacked;
        expect(stacked.exitCode, stacked.log).toBe(0);
        const stackedFailed = runs.stackedFailed;
        expect(stackedFailed.exitCode).not.toBe(0);
        const moved = runs.moved;
        expect(moved.exitCode).not.toBe(0);
        const observed = runs.observed;
        expect(observed.exitCode, observed.log).toBe(0);
        expect(decided(observed.log)).toMatchObject({ mode: "observe", decision: "would pass" });
        const draftAgain = runs.draftAgain;
        expect(draftAgain.exitCode).not.toBe(0);
        expect(decided(draftAgain.log)).toMatchObject({ mode: "enforce", decision: "fail" });
        expect(decided(draftAgain.log)!.reason).toContain(
          "this layer is ready for review, and #11 is a draft now, so no run of it gates a merge",
        );
        expect(decided(draftAgain.log)!.message).toContain("gh pr ready 11");
        const stackedDraft = runs.stackedDraft;
        expect(stackedDraft.exitCode).not.toBe(0);
        const paged = runs.paged;
        expect(paged.exitCode, paged.log).toBe(0);
        expect(decided(paged.log)).toMatchObject({ decision: "pass", rule: "gate" });
        expect(
          paged.calls.some((call) => call.includes("/runs/600/jobs?per_page=100&page=2")),
        ).toBe(true);
        const pagedRed = runs.pagedRed;
        expect(pagedRed.exitCode).not.toBe(0);
        expect(decided(pagedRed.log)!.reason).toContain(
          "ended with checks / check success and checks / e2e failure",
        );
      }),
  );

  it.effect(
    "observing, the skip check logs what it would decide and passes, as a skip layer always did",
    () =>
      Effect.gen(function* () {
        const fits = yield* baseline(["above"], skipLayer(), upper(good));
        expect(fits.exitCode, fits.log).toBe(0);
        expect(decided(fits.log)).toMatchObject({
          mode: "observe",
          decision: "would pass",
          oldFormat: false,
          reason:
            "#11's run https://github.com/owner/repository/actions/runs/600 was built on ccccccccc and compared its Worker sizes with main",
        });
        expect(fits.outputs.decision).toBe("pass");
        expect(fits.log).toContain("the token's rate limit: core 120 used of 1000, 880 left");
        const fails = yield* baseline(["above"], skipLayer(), upper(laundered));
        expect(fails.exitCode, fails.log).toBe(0);
        const failure = decided(fails.log)!;
        expect(failure).toMatchObject({ mode: "observe", decision: "would fail" });
        expect(failure.reason).toBe(
          "#11's latest run on its head, https://github.com/owner/repository/actions/runs/600, compared its Worker sizes with effect-apps, not main, the base this stack now ends on",
        );
        expect(failure.message).toContain(
          "To fix it, run it again: gh run rerun 600 --repo owner/repository (a re-run reads the stack afresh); once that run has started, run this one again: gh run rerun 500 --repo owner/repository",
        );
        expect(failure.waited).toBeGreaterThanOrEqual(240);
        expect(fails.outputs.decision).toBe("fail");
        expect(fails.calls.filter((call) => call.includes("/pulls?base="))).not.toHaveLength(1);
        expect(fails.calls.filter((call) => call.startsWith("run download"))).toHaveLength(1);
        const moved = decided(
          (yield* baseline(["above"], skipLayer(), upper(record(sha("b"), `main@${sha("6")}`))))
            .log,
        )!;
        expect(moved.reason).toContain("was built on bbbbbbbbb, not this layer's head ccccccccc");
        expect(moved.message).toContain("gh stack rebase, then gh stack push");
        for (const [text, why] of [
          [good.replace(/baseline .*\n/, ""), "a baseline it did not record"],
          [record(lowerHead, `main@${sha("6")}`, "5"), "wrote a record in format 5"],
          [good.replace("above none", "above fail"), "its own check of the layer above it fails"],
          [good.replace("above none", "above error"), "its own check of the layer above it fails"],
        ] as const)
          expect(
            decided((yield* baseline(["above"], skipLayer(), upper(text))).log)?.reason,
          ).toContain(why);
      }),
  );

  it.effect(
    "a record in the format from before the check is judged by the old rule and passes, with a notice",
    () =>
      Effect.gen(function* () {
        for (const text of [
          record(sha("b"), "", "").replace(/baseline .*\n/, ""),
          "pull request 11\nmerge tree x\nselection x\n",
        ]) {
          const old = yield* baseline(["above"], skipLayer(), upper(text));
          expect(old.exitCode, old.log).toBe(0);
          expect(decided(old.log)).toMatchObject({ decision: "would pass", oldFormat: true });
          expect(old.log).toContain(
            "::notice title=Skip check::The layer above runs a workflow from before the skip check. Rebasing the stack onto main turns the check on.",
          );
        }
        const unformatted = yield* baseline(
          ["above"],
          skipLayer(),
          upper(record(lowerHead, `scratch@${sha("5")}`, "")),
        );
        expect(decided(unformatted.log)).toMatchObject({
          decision: "would fail",
          oldFormat: false,
        });
      }),
  );

  it.effect(
    "the newest CI run of this repository that recorded decides, and its newest record",
    () =>
      Effect.gen(function* () {
        const verdict = (more: GitHubAnswers) =>
          Effect.map(baseline(["above"], skipLayer(), upper(good, more)), (run) => ({
            ...decided(run.log)!,
            calls: run.calls,
          }));
        expect(
          (yield* verdict({
            upperRuns: { [upperHead]: [{ id: 600 }, { id: 599 }] },
            records: {
              "600": { name: "ci-tested-pr11-new", text: laundered },
              "599": { name: "ci-tested-pr11-old", text: good },
            },
          })).decision,
        ).toBe("would pass");
        const raced = yield* verdict({
          upperRuns: { [upperHead]: [{ id: 43809112880 }, { id: 43809112745 }] },
          records: {
            "43809112880": {
              name: "ci-tested-pr11-newer",
              text: record(sha("a"), `main@${sha("6")}`),
            },
            "43809112745": { name: "ci-tested-pr11-older", text: good },
          },
        });
        expect(raced.decision).toBe("would pass");
        expect(raced.reason).toContain("runs/43809112745 was built on ccccccccc");
        const queued = decided(
          (yield* baseline(
            ["above"],
            skipLayer(),
            upper(good, {
              upperRuns: {
                [upperHead]: [
                  { id: 43814604673, status: "in_progress", conclusion: null },
                  { id: 43814603973 },
                ],
              },
              records: {
                "43814604673": { name: "ci-tested-pr11-queued", text: good, after: 7 },
                "43814603973": {
                  name: "ci-tested-pr11-first",
                  text: record(sha("a"), `main@${sha("6")}`),
                },
              },
              selectJobs: { "43814604673": { status: "in_progress" } },
            }),
          )).log,
        )!;
        expect(queued).toMatchObject({ decision: "would pass" });
        expect(queued.waited).toBeGreaterThan(240);
        expect(
          (yield* verdict({
            upperRuns: { [upperHead]: [{ id: 600 }, { id: 599 }] },
            records: {
              "600": { name: "ci-tested-pr11-new", text: record(sha("a"), `main@${sha("6")}`) },
              "599": { name: "ci-tested-pr11-old", text: laundered },
            },
          })).reason,
        ).toContain("runs/600, was built on aaaaaaaaa");
        const passedOver = yield* verdict({
          upperRuns: {
            [upperHead]: [
              { id: 605, path: ".github/workflows/pr-previews.yml" },
              { id: 604, conclusion: "cancelled" },
              { id: 603, repository: "someone/fork" },
              { id: 602, status: "in_progress", conclusion: null },
              { id: 600 },
            ],
          },
          records: {
            "605": { name: "ci-tested-pr11-other", text: laundered },
            "604": { name: "ci-tested-pr11-cancelled", text: laundered },
            "603": { name: "ci-tested-pr11-fork", text: laundered },
            "600": { name: "ci-tested-pr11-key", text: good },
          },
          selectJobs: { "602": { status: "in_progress" } },
        });
        expect(passedOver.decision).toBe("would pass");
        expect(passedOver.calls.filter((call) => call.startsWith("run download"))).toEqual([
          expect.stringMatching(/^run download 600 /),
        ]);
        expect(
          (yield* verdict({
            upperRuns: { [upperHead]: [{ id: 601, conclusion: "failure" }, { id: 600 }] },
          })).decision,
        ).toBe("would pass");
        expect(
          (yield* verdict({
            upperRuns: { [upperHead]: [{ id: 601, conclusion: "failure" }, { id: 600 }] },
            records: { "600": { name: "ci-tested-pr11-old", text: laundered } },
          })).reason,
        ).toContain("recorded nothing (its select failed)");
        const twice = yield* verdict({
          records: {
            "600": [
              { id: 6002, name: "ci-tested-pr11-b", text: laundered },
              { id: 6003, name: "ci-tested-pr11-c", text: good },
              { id: 6001, name: "ci-tested-pr11-a", text: laundered },
            ],
          },
        });
        expect(twice.decision).toBe("would pass");
        const others = yield* verdict({
          otherArtifacts: {
            "600": [
              { id: 9001, name: "ci-tested-pr12-other" },
              { id: 9002, name: "ci-sized-pr11-key" },
            ],
          },
        });
        expect(others.decision).toBe("would pass");
        const paged = yield* verdict({
          otherArtifacts: {
            "600": Array.from({ length: 120 }, (_, index) => ({
              id: 9100 + index,
              name: `e2e-self-host-resources-evidence-${index}-attempt-4`,
            })),
          },
        });
        expect(paged.decision).toBe("would pass");
        expect(paged.calls.filter((call) => call.includes("/runs/600/artifacts"))).toEqual([
          expect.stringContaining("page=1"),
          expect.stringContaining("page=2"),
        ]);
        expect(
          (yield* verdict({
            uppers: [{ number: 11, headRefOid: upperHead, isCrossRepository: true }],
          })).reason,
        ).toBe("no open pull request in this repository has lower as its base");
        expect((yield* verdict({ upperRuns: { [sha("9")]: [{ id: 600 }] } })).reason).toBe(
          "#11 has no CI run on its head ddddddddd",
        );
      }),
  );

  it.effect(
    "a run passes when the merge commit it tested contains this layer's head, whatever its event's base",
    () =>
      Effect.gen(function* () {
        const run = (text: string, more: GitHubAnswers = {}) =>
          Effect.map(baseline(["above"], skipLayer(), upper(text, more)), (result) => ({
            ...decided(result.log)!,
            exitCode: result.exitCode,
            calls: result.calls,
          }));
        const tested = sha("f");
        const pair = `${lowerHead}...${tested}`;
        const stale = yield* run(record(sha("b"), `main@${sha("6")}`, "3", tested), {
          contains: { [pair]: "ahead" },
        });
        expect(stale).toMatchObject({ decision: "would pass", rule: "tested", waited: 0 });
        expect(stale.reason).toBe(
          `#11's run https://github.com/owner/repository/actions/runs/600 tested a merge commit that contains ccccccccc, and compared its Worker sizes with main`,
        );
        expect(stale.calls.filter((call) => call.includes("/compare/"))).toEqual([
          `api repos/owner/repository/compare/${pair}?per_page=1 --jq .status`,
        ]);
        expect(
          (yield* run(record(sha("b"), `main@${sha("6")}`, "3", tested), {
            contains: { [pair]: "identical" },
          })).rule,
        ).toBe("tested");
        for (const status of ["behind", "diverged"]) {
          const not = yield* run(record(sha("b"), `main@${sha("6")}`, "3", tested), {
            contains: { [pair]: status },
          });
          expect(not).toMatchObject({ decision: "would fail", rule: "none" });
          expect(not.waited).toBeGreaterThanOrEqual(240);
          expect(not.reason).toBe(
            "#11's latest run on its head, https://github.com/owner/repository/actions/runs/600, was built on bbbbbbbbb and tested fffffffff, which does not contain this layer's head ccccccccc",
          );
          expect(not.exitCode).toBe(0);
          expect(not.calls.filter((call) => call.includes("/compare/"))).toHaveLength(1);
        }
        const unread = yield* run(record(sha("b"), `main@${sha("6")}`, "3", tested), {
          contains: { [pair]: "fail" },
        });
        expect(unread).toMatchObject({ decision: "would fail", exitCode: 0 });
        expect(unread.reason).toContain(
          "tested fffffffff, and whether that contains this layer's head ccccccccc could not be read",
        );
        expect(unread.calls.filter((call) => call.includes("/compare/")).length).toBeGreaterThan(1);
        const based = yield* run(record(lowerHead, `main@${sha("6")}`, "3", tested));
        expect(based).toMatchObject({ decision: "would pass", rule: "base" });
        expect(based.calls.filter((call) => call.includes("/compare/"))).toEqual([]);
        expect(yield* run(record(lowerHead, `main@${sha("6")}`, "2"))).toMatchObject({
          decision: "would pass",
          rule: "base",
        });
        expect(
          (yield* run(record(sha("b"), `main@${sha("6")}`, "2"), {
            contains: { [`${lowerHead}...${sha("b")}`]: "ahead" },
          })).reason,
        ).toContain("was built on bbbbbbbbb, not this layer's head ccccccccc");
        expect(
          (yield* run(record(sha("b"), `effect-apps@${sha("5")}`, "3", tested), {
            contains: { [pair]: "ahead" },
          })).reason,
        ).toContain("compared its Worker sizes with effect-apps, not main");
        const rerun = yield* run(record(sha("b"), `main@${sha("6")}`, "3", tested), {
          records: {
            "600": [
              {
                id: 6001,
                name: "ci-tested-pr11-first",
                text: record(sha("b"), `effect-apps@${sha("5")}`, "3", tested),
              },
              {
                id: 6002,
                name: "ci-tested-pr11-rerun",
                text: record(sha("b"), `main@${sha("6")}`, "3", tested),
                after: 3,
              },
            ],
          },
          contains: { [pair]: "ahead" },
        });
        expect(rerun).toMatchObject({ decision: "would pass", rule: "tested" });
        expect(rerun.waited).toBeGreaterThan(0);
      }),
  );

  it.effect(
    "the five would-fail decisions of 16 Nov, replayed through the rule that reads what was tested",
    () =>
      Effect.gen(function* () {
        const layer = (head: string, bottom = "effect-apps") => ({
          ...skipLayer(bottom),
          HEAD_SHA: head,
        });
        const upperOf = (head: string, text: string, more: GitHubAnswers = {}): GitHubAnswers => ({
          uppers: [{ number: 11, headRefOid: head }],
          upperRuns: { [head]: [{ id: 600 }] },
          records: { "600": { name: "ci-tested-pr11-key", text } },
          ...more,
        });
        const at = (base: string, tested: string, bottom: string) =>
          `format 3\npull request 11\nmerge tree ${sha("e")}\nbase ${base}\ntested ${tested}\nselection x\nworker-growth y\nbaseline ${bottom}@${sha("6")}\nabove none\n`;
        const verdict = (env: Record<string, string>, answers: GitHubAnswers) =>
          Effect.map(baseline(["above"], env, answers), (result) => decided(result.log)!);
        const gatewayLower = "4ad0afbc33d43392c0bc2f42b2b9ba94b5e8cc46";
        const gatewayUpper = "66f85fc61cf5b4954e43441a7951f782f249efc6";
        expect(
          yield* verdict(
            layer(gatewayLower),
            upperOf(
              gatewayUpper,
              at("1b8f78414ff4a924ff47bf329e5f2bda654a215a", gatewayUpper, "effect-apps"),
              { contains: { [`${gatewayLower}...${gatewayUpper}`]: "ahead" } },
            ),
          ),
        ).toMatchObject({ decision: "would pass", rule: "tested" });
        const scaleLower = "d2a3db73d8d8f4d2eb4e9bc069afe0a5dc4ad51c";
        const searchUpper = "4565abc0d02794b172a53b6eda419e3a2be5c999";
        expect(
          yield* verdict(
            layer(scaleLower),
            upperOf(
              searchUpper,
              at("958abd22a4b73542c8260c28d3f14c3e1ed5232f", searchUpper, "effect-apps"),
              { contains: { [`${scaleLower}...${searchUpper}`]: "ahead" } },
            ),
          ),
        ).toMatchObject({ decision: "would pass", rule: "tested" });
        const grantLower = "6fcd6f179a7f94ce4754075d8183a33af14ddca8";
        expect(
          yield* verdict(
            layer(grantLower),
            upperOf(
              scaleLower,
              at(grantLower, scaleLower, "effect-apps").replace("above none", "above pass"),
            ),
          ),
        ).toMatchObject({ decision: "would pass", rule: "base" });
        expect(
          (yield* verdict(
            layer(grantLower),
            upperOf(
              scaleLower,
              at(grantLower, scaleLower, "effect-apps").replace("above none", "above fail"),
            ),
          )).decision,
        ).toBe("would fail");
        const sqlLower = "7d64b6538eab858e3b9cd58f2826dbf3599a1a46";
        const sqlUpper = sha("9");
        const sql = yield* verdict(layer(sqlLower), {
          uppers: [{ number: 11, headRefOid: sqlUpper }],
          upperRuns: {
            [sqlUpper]: [
              { id: 43928367877, conclusion: "failure" },
              { id: 43928367036, conclusion: "failure" },
            ],
          },
        });
        expect(sql).toMatchObject({ decision: "would fail", rule: "none" });
        expect(sql.reason).toContain("recorded nothing (its select failed)");
      }),
  );

  it.effect(
    "the check waits by what it sees, reads again only what changed, and takes a failed read for no answer",
    () =>
      Effect.gen(function* () {
        const late = yield* baseline(
          ["above"],
          skipLayer(),
          upper(good, {
            upperRuns: { [upperHead]: [{ id: 600, status: "in_progress", conclusion: null }] },
            records: { "600": { name: "ci-tested-pr11-key", text: good, after: 2 } },
          }),
        );
        expect(decided(late.log)).toMatchObject({ decision: "would pass" });
        expect(late.calls.filter((call) => call.includes("/pulls?base="))).toHaveLength(3);
        expect(late.calls.filter((call) => call.includes("If-None-Match"))).not.toHaveLength(0);
        expect(late.calls.filter((call) => call.startsWith("run download"))).toHaveLength(1);
        expect(late.log).toMatch(/this check made \d+ counted requests and [1-9]\d* unchanged/);
        const choosing = {
          upperRuns: { [upperHead]: [{ id: 600, status: "in_progress", conclusion: null }] },
          records: { "600": { name: "ci-tested-pr11-key", text: good, after: 7 } },
        };
        const slow = decided((yield* baseline(["above"], skipLayer(), upper(good, choosing))).log)!;
        expect(slow).toMatchObject({ decision: "would pass" });
        expect(slow.waited).toBeGreaterThan(240);
        const chained = decided(
          (yield* baseline(
            ["above"],
            skipLayer(),
            upper(good, {
              ...choosing,
              records: { "600": { name: "ci-tested-pr11-key", text: good, after: 18 } },
              selectJobs: { "600": { status: "in_progress", waitingAbove: true } },
            }),
          )).log,
        )!;
        expect(chained).toMatchObject({ decision: "would pass" });
        expect(chained.waited).toBeGreaterThan(900);
        expect(
          decided(
            (yield* baseline(
              ["above"],
              skipLayer(),
              upper(good, {
                ...choosing,
                records: { "600": { name: "ci-tested-pr11-key", text: good, after: 18 } },
              }),
            )).log,
          ),
        ).toMatchObject({ decision: "would fail" });
        const pushed = yield* baseline(
          ["above"],
          skipLayer(),
          upper(good, {
            upperSnapshots: [
              [{ number: 11, headRefOid: upperHead }],
              [{ number: 11, headRefOid: upperHead }],
              [{ number: 11, headRefOid: sha("8") }],
            ],
            upperRuns: { [upperHead]: [{ id: 600 }], [sha("8")]: [{ id: 610 }] },
            records: {
              "600": { name: "ci-tested-pr11-old", text: laundered },
              "610": { name: "ci-tested-pr11-new", text: good },
            },
          }),
        );
        expect(decided(pushed.log)).toMatchObject({ decision: "would pass" });
        const flaky = yield* baseline(
          ["above"],
          skipLayer(),
          upper(good, { flaky: { "run download": 4 } }),
        );
        expect(decided(flaky.log)).toMatchObject({ decision: "would pass" });
        expect(flaky.log).toContain("Waiting: the pull requests above could not be read");
        const down = decided(
          (yield* baseline(["above"], skipLayer(), upper(good, { failPullRequests: true }))).log,
        )!;
        expect(down).toMatchObject({ decision: "would fail" });
        expect(down.reason).toContain("the pull requests above could not be read");
        expect(down.waited).toBeGreaterThanOrEqual(240);
      }),
  );

  it.effect(
    "no read can hang the check: each has its own time limit, and one that passes is no answer",
    () =>
      Effect.gen(function* () {
        const { stalled, download, slow, never } = yield* Effect.all(
          {
            stalled: baseline(
              ["above"],
              skipLayer(),
              upper(good, { hangs: { "/pulls?base=": 2 } }),
            ),
            download: baseline(
              ["above"],
              skipLayer(),
              upper(good, { hangs: { "run download": 1 } }),
            ),
            slow: baseline(
              ["above"],
              skipLayer(),
              upper(good, { slow: { "/actions/runs": 700, "run download": 700 } }),
            ),
            never: baseline(
              ["above"],
              skipLayer(),
              upper(good, { hangs: { "/pulls?base=": 1000 } }),
            ),
          },
          { concurrency: "unbounded" },
        );
        expect(decided(stalled.log)).toMatchObject({ decision: "would pass" });
        expect(stalled.log).toContain("Waiting: the pull requests above could not be read (");
        expect(stalled.log).toContain(
          "repos/owner/repository/pulls?base=lower&state=open&per_page=100: no answer within 1 s",
        );
        expect(decided(download.log)).toMatchObject({ decision: "would pass" });
        expect(decided(slow.log)).toMatchObject({ decision: "would fail" });
        expect(decided(slow.log)?.reason).toContain("the look got no answer within 2 s");
        expect(never.exitCode).toBe(0);
        expect(decided(never.log)).toMatchObject({ decision: "would fail" });
        expect(decided(never.log)?.reason).toContain("no answer within");
      }),
  );

  it.effect(
    "observing, nothing in the check can fail the step; enforcing, a defect still fails it",
    () =>
      Effect.gen(function* () {
        const lower = {
          ref: "lower",
          head: lowerHead,
          bottom: "main",
          repository: "o/r",
          runId: "5",
          ready: false,
        };
        const throwing = Effect.sync(() =>
          skipCheck.next(
            skipCheck.judge(
              { _tag: "Read", uppers: null } as unknown as skipCheck.Observation,
              lower,
            ),
            lower,
            0,
            0,
          ),
        ).pipe(
          Effect.map((step) => {
            if (step._tag !== "Done") throw new Error("not done");
            return step.decision;
          }),
        );
        const observed = yield* skipCheck.guarded(throwing, false);
        expect(observed._tag).toBe("Error");
        expect(skipCheck.fails(observed, false)).toBe(false);
        expect(skipCheck.fails(observed, true)).toBe(true);
        expect(skipCheck.decisionLine(observed, false)).toMatch(
          /^skip-check \{"mode":"observe","decision":"error","reason":"TypeError: .*"\}$/,
        );
        expect(skipCheck.summarySentence(observed, false)).toContain("It passes while observing.");
        const enforced = yield* Effect.exit(skipCheck.guarded(throwing, true));
        expect(enforced._tag).toBe("Failure");
        const missing = yield* baseline(["above"], { ...skipLayer(), HEAD_SHA: "" }, upper(good));
        expect(missing.exitCode, missing.log).toBe(0);
        expect(decided(missing.log)).toMatchObject({ mode: "observe", decision: "error" });
        expect(missing.outputs.decision).toBe("error");
        const unwritable = yield* baseline(
          ["above"],
          { ...skipLayer(), GITHUB_STEP_SUMMARY: "/" },
          upper(good),
        );
        expect(unwritable.exitCode, unwritable.log).toBe(0);
        expect(decided(unwritable.log)).toMatchObject({ decision: "would pass" });
        expect(unwritable.log).toContain("The skip check's report could not be written");
      }),
  );

  it.effect(
    "select's baseline step cannot fail select: whatever goes wrong, it compares with main",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const checks = yield* fs.readFileString(".github/workflows/checks.yml");
        const select = checks.slice(checks.indexOf("  select:"), checks.indexOf("\n  static:"));
        const step = select.slice(select.indexOf("        id: baseline\n"));
        const script = step
          .slice(step.indexOf("        run: |\n") + "        run: |\n".length)
          .split("\n")
          .filter((line, index, lines) =>
            lines.slice(0, index + 1).every((each) => each.startsWith("          ")),
          )
          .map((line) => line.slice(10))
          .join("\n");
        expect(script).toContain("if ! node scripts/ci/worker-baseline.ts resolve; then");
        const run = (env: Readonly<Record<string, string>>) =>
          Effect.gen(function* () {
            const directory = yield* fs.makeTempDirectoryScoped({
              prefix: "executor-baseline-step-",
            });
            const output = path.join(directory, "output");
            yield* fs.writeFileString(output, "");
            const child = yield* processes.spawn(
              ChildProcess.make("bash", ["-e", "-o", "pipefail", "-c", script], {
                env: { DEFAULT_BRANCH: "main", GITHUB_OUTPUT: output, ...env },
                extendEnv: true,
              }),
            );
            const [log, exitCode] = yield* Effect.all(
              [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
              { concurrency: "unbounded" },
            );
            return { log, exitCode: Number(exitCode), output: yield* fs.readFileString(output) };
          }).pipe(Effect.scoped);
        const crashed = yield* run({
          GITHUB_REPOSITORY: "owner/repository",
          BASE_REF: "effect-apps",
          HEAD_SHA: head,
          BASE_SHA: "",
          PATH: process.env["PATH"] ?? "",
        });
        expect(crashed.exitCode, crashed.log).toBe(0);
        expect(crashed.log).toContain(
          "::warning title=Worker sizes::The baseline for Worker sizes could not be chosen (see this step's log), so this run compares with main.",
        );
        expect(crashed.output).toMatch(/branch=main\nid=main@unread\nlabel=main\n$/);
      }),
  );

  it.effect(
    "on a push to main, site's baseline steps cannot fail site; on a pull request they fail closed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const checks = yield* fs.readFileString(".github/workflows/checks.yml");
        const site = checks.slice(
          checks.indexOf("\n  site:\n"),
          checks.indexOf("\n  apps-package:\n"),
        );
        const body = (step: string) => {
          const text = site.slice(site.indexOf(`      - name: ${step}\n`));
          return text
            .slice(text.indexOf("        run: |\n") + "        run: |\n".length)
            .split("\n")
            .filter((line, index, lines) =>
              lines
                .slice(0, index + 1)
                .every((each) => each.startsWith("          ") || each === ""),
            )
            .map((line) => line.slice(10))
            .join("\n");
        };
        for (const step of [
          "Choose the baseline for Worker sizes",
          "Fetch the baseline's Worker sizes",
        ]) {
          const script = body(step);
          expect(script, step).toContain("node scripts/ci/worker-baseline.ts");
          const run = (event: string) =>
            Effect.gen(function* () {
              const directory = yield* fs.makeTempDirectoryScoped({
                prefix: "executor-site-step-",
              });
              const bin = path.join(directory, "bin");
              yield* fs.makeDirectory(bin);
              yield* fs.writeFileString(
                path.join(bin, "node"),
                "#!/bin/sh\necho crashed >&2\nexit 7\n",
              );
              yield* fs.chmod(path.join(bin, "node"), 0o755);
              yield* fs.makeDirectory(path.join(directory, ".local/worker-uploads-base"), {
                recursive: true,
              });
              yield* fs.writeFileString(
                path.join(directory, ".local/worker-uploads-base/api.json"),
                "{",
              );
              const child = yield* processes.spawn(
                ChildProcess.make("bash", ["-e", "-o", "pipefail", "-c", script], {
                  cwd: directory,
                  env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, GITHUB_EVENT_NAME: event },
                  extendEnv: true,
                }),
              );
              const [log, exitCode] = yield* Effect.all(
                [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
                { concurrency: "unbounded" },
              );
              return {
                log,
                exitCode: Number(exitCode),
                left: yield* fs.exists(path.join(directory, ".local/worker-uploads-base")),
              };
            }).pipe(Effect.scoped);
          const push = yield* run("push");
          expect(push.exitCode, `${step}: ${push.log}`).toBe(0);
          expect(push.log, step).toContain("so this push's growth is reported and not checked.");
          if (step === "Fetch the baseline's Worker sizes") expect(push.left).toBe(false);
          const pull = yield* run("pull_request");
          expect(pull.exitCode, step).toBe(1);
        }
      }),
  );

  const stepScript = (workflow: string, step: string) => {
    const text = workflow.slice(workflow.indexOf(`      - name: ${step}\n`));
    return text
      .slice(text.indexOf("        run: |\n") + "        run: |\n".length)
      .split("\n")
      .filter((line, index, lines) =>
        lines.slice(0, index + 1).every((each) => each.startsWith("          ") || each === ""),
      )
      .map((line) => line.slice(10))
      .join("\n");
  };
  const timingStep = "Time the Workers' start-up against the previous push";

  it.effect("the start-up record runs only on a push, and nothing in it can fail site", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const checks = yield* fs.readFileString(".github/workflows/checks.yml");
      const site = checks.slice(
        checks.indexOf("\n  site:\n"),
        checks.indexOf("\n  apps-package:\n"),
      );
      const from = site.indexOf("      - name: Keep this push's built Workers for the next push\n");
      expect(from).toBeGreaterThan(-1);
      const steps = site
        .slice(from)
        .split(/\n(?= {6}- )/)
        .filter((step) => step.includes("worker-build") || step.includes("startup"));
      expect(steps.length).toBe(5);
      for (const step of steps) {
        const condition = step.match(/^(?: {6}- | {8})if: (.*)$/m)?.[1] ?? "";
        expect(
          condition.includes("github.event_name == 'push'") ||
            /steps\.(build-kept|startup)\.outputs\.path != ''/.test(condition),
          step.slice(0, 80),
        ).toBe(true);
        expect(condition, step.slice(0, 80)).toContain("!cancelled()");
        expect(step, step.slice(0, 80)).toContain("        continue-on-error: true\n");
        expect(step, step.slice(0, 80)).toMatch(/^ {8}timeout-minutes: \d+$/m);
      }
      const limit = Number(site.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
      const steps_ = steps.map((step) => Number(step.match(/^ {8}timeout-minutes: (\d+)$/m)?.[1]));
      expect(limit - steps_.reduce((sum, minutes) => sum + minutes, 0)).toBeGreaterThanOrEqual(0);
      expect(stepScript(site, timingStep)).toContain('timeout -s KILL "$LIMIT" node "$HARNESS"');
      expect(site).toContain('          LIMIT: "360"\n');
    }),
  );

  it.effect(
    "a crash, a hang and a missing previous build each leave a notice; a record names what it compared",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const script = stepScript(
          yield* fs.readFileString(".github/workflows/checks.yml"),
          timingStep,
        );
        const head = sha("c");
        const before = sha("b");
        const measured = {
          workerd: "1.20260918.1",
          runs: 21,
          machine: { cpus: 4, loadBefore: [1, 1, 1], loadAfter: [1, 1, 1] },
          skipped: {},
          workers: {
            api: {
              staticModules: { base: 23, head: 24 },
              staticBytes: { base: 3_750_524, head: 3_800_524 },
              compile: { base: { median: 80, min: 78 }, head: { median: 82, min: 80 } },
              evaluate: { base: { median: 230, min: 226 }, head: { median: 236, min: 231 } },
            },
          },
        };
        const run = (harness: string, env: Readonly<Record<string, string>>) =>
          Effect.gen(function* () {
            const directory = yield* fs.makeTempDirectoryScoped({
              prefix: "executor-startup-step-",
            });
            const stand = path.join(directory, "harness.mjs");
            yield* fs.writeFileString(stand, harness);
            yield* fs.makeDirectory(path.join(directory, "base", "bundles"), { recursive: true });
            const output = path.join(directory, "output");
            yield* fs.writeFileString(output, "");
            const started = Date.now();
            const child = yield* processes.spawn(
              ChildProcess.make("bash", ["-e", "-o", "pipefail", "-c", script], {
                env: {
                  GITHUB_EVENT_NAME: "push",
                  RUNNER_TEMP: directory,
                  GITHUB_OUTPUT: output,
                  GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
                  HEAD_SHA: head,
                  BEFORE_SHA: before,
                  BASE_COMMIT: before,
                  BASE_BUILD: path.join(directory, "base"),
                  HARNESS: stand,
                  LIMIT: "2",
                  ARGS_FILE: path.join(directory, "args"),
                  ...env,
                },
                extendEnv: true,
              }),
            );
            const [log, exitCode] = yield* Effect.all(
              [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
              { concurrency: "unbounded" },
            );
            const record = path.join(directory, "worker-startup", "record", "worker-startup.json");
            return {
              log,
              exitCode: Number(exitCode),
              seconds: (Date.now() - started) / 1000,
              outputs: yield* fs.readFileString(output),
              record: (yield* fs.exists(record))
                ? (JSON.parse(yield* fs.readFileString(record)) as Record<string, unknown>)
                : undefined,
              args: (yield* fs.exists(path.join(directory, "args")))
                ? yield* fs.readFileString(path.join(directory, "args"))
                : "",
              base: path.join(directory, "base"),
            };
          }).pipe(Effect.scoped);
        const printing = `import fs from "node:fs";\nfs.writeFileSync(process.env.ARGS_FILE, process.argv.slice(2).join(" "));\nconsole.log(${JSON.stringify(JSON.stringify(measured))});\n`;
        const compared = yield* run(printing, {});
        expect(compared.exitCode, compared.log).toBe(0);
        expect(compared.args).toBe(`--base ${compared.base} --head apps/hosted/cloud`);
        expect(compared.record).toMatchObject({
          commit: head,
          before,
          base: before,
          workers: {
            api: {
              staticBytes: { base: 3_750_524, head: 3_800_524 },
              evaluate: {
                base: { median: 230, min: 226 },
                head: { median: 236, min: 231 },
                difference: 6,
              },
            },
          },
        });
        expect(compared.outputs).toMatch(/^path=.*\/worker-startup\/record$/m);
        const alone = yield* run(printing, { BASE_COMMIT: "" });
        expect(alone.exitCode, alone.log).toBe(0);
        expect(alone.args).toBe("--base apps/hosted/cloud --head apps/hosted/cloud");
        expect(alone.record).toMatchObject({
          commit: head,
          base: null,
          workers: { api: { evaluate: { base: null, difference: null } } },
        });
        const crashed = yield* run("process.exit(3);\n", {});
        expect(crashed.exitCode, crashed.log).toBe(0);
        expect(crashed.log).toContain(
          "::notice title=Worker start-up::The start-up measurement did not finish (exit 3, 137 when its 2-second limit stopped it",
        );
        expect(crashed.record).toBeUndefined();
        expect(crashed.outputs).not.toContain("path=");
        const hung = yield* run(
          `import { spawn } from "node:child_process";\nspawn("sleep", ["637"], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n`,
          {},
        );
        expect(hung.exitCode, hung.log).toBe(0);
        expect(hung.log).toContain("did not finish (exit 137");
        expect(hung.seconds).toBeLessThan(15);
        const left = yield* processes.spawn(ChildProcess.make("pgrep", ["-f", "sleep 637"]));
        const [found] = yield* Effect.all(
          [left.stdout.pipe(Stream.decodeText(), Stream.mkString), left.exitCode],
          { concurrency: "unbounded" },
        );
        expect(found.trim()).toBe("");
        expect(hung.record).toBeUndefined();
      }),
    20_000,
  );

  it.effect(
    "the previous push's build is used only from main's push run of the commit it names",
    () =>
      Effect.gen(function* () {
        const env = { BASE_SHA: sha("a") };
        const kept = { "worker-build": { api: { bytes: 1 } } };
        const found = yield* baseline(["fetch-build", "<sizes>"], env, {
          runs: { [sha("a")]: "88" },
          downloads: kept,
          builtFrom: { "worker-build": sha("a") },
        });
        expect(found.exitCode, found.log).toBe(0);
        expect(found.outputs).toEqual({ found: "true", commit: sha("a") });
        expect(found.calls.find((call) => call.startsWith("run list"))).toContain("--event push");
        for (const named of [sha("9"), null]) {
          const other = yield* baseline(["fetch-build", "<sizes>"], env, {
            runs: { [sha("a")]: "88" },
            downloads: kept,
            builtFrom: { "worker-build": named },
          });
          expect(other.outputs, String(named)).toEqual({ found: "false", commit: "" });
          expect(other.sizes, String(named)).toEqual([]);
          expect(other.log).toContain("so it is not used.");
        }
        const stepped = yield* baseline(["fetch-build", "<sizes>"], env, {
          commits: {
            [sha("a")]: {
              message: "Release 2.0.0-beta.56 [skip ci]",
              author: "github-actions[bot]",
              parents: [sha("b")],
              files: releaseFiles("56"),
            },
          },
          runs: { [sha("b")]: "87" },
          downloads: kept,
          builtFrom: { "worker-build": sha("b") },
        });
        expect(stepped.outputs).toEqual({ found: "true", commit: sha("b") });
        const none = yield* baseline(["fetch-build", "<sizes>"], env, {});
        expect(none.exitCode).toBe(0);
        expect(none.outputs).toEqual({ found: "false", commit: "" });
        expect(none.log).toContain("so this push's start-up is recorded alone.");
      }),
  );

  it.effect(
    "a duplicate queued behind a run that is testing for a merge waits as long as the testing, and names the other run's answer",
    () =>
      Effect.sync(() => {
        const lower = {
          ref: "lower",
          head: lowerHead,
          bottom: "main",
          repository: "o/r",
          runId: "5",
          ready: true,
        };
        const gated = skipCheck.parseRecord(
          `format 4\npull request 11\nmerge tree ${sha("e")}\nbase ${lowerHead}\ntested ${sha("e")}\nselection x\nworker-growth y\nbaseline main@${sha("6")}\nabove none\ngate full\n`,
        );
        const look = (gates: { check?: string; e2e?: string }) =>
          skipCheck.judge(
            {
              _tag: "Read",
              uppers: [
                {
                  pull: 11,
                  head: upperHead,
                  draft: false,
                  runs: [
                    { id: 1, url: "u1", selectDone: false, waitingAbove: false },
                    {
                      id: 2,
                      url: "u2",
                      record: gated,
                      selectDone: true,
                      waitingAbove: false,
                      gates,
                    },
                  ],
                },
              ],
            },
            lower,
          );
        const testing = look({});
        expect(testing).toMatchObject({ _tag: "Wait", bound: "testing" });
        if (testing._tag !== "Wait") return;
        expect(testing.why).toContain("u1, has not chosen what it tests yet");
        expect(testing.why).toContain("u2, runs the full suite for a merge and has not finished");
        expect(skipCheck.next(testing, lower, skipCheck.bounds.selecting + 1, 9)._tag).toBe("Poll");
        expect(look({ check: "success", e2e: "success" })).toMatchObject({
          _tag: "Pass",
          run: "u2",
        });
        const failed = look({ check: "success", e2e: "failure" });
        expect(failed).toMatchObject({ _tag: "Fail" });
        if (failed._tag !== "Fail") return;
        expect(failed.why).toContain("ended with checks / check success and checks / e2e failure");
        expect(failed.remedy).toContain("fix #11");
        expect(failed.why).toContain("run u1 on the same head has not chosen yet");
      }),
  );

  it.effect(
    "a ready skip layer fails at once when a required check above has failed, passes only when both passed, and waits only while neither has failed and one runs",
    () =>
      Effect.sync(() => {
        const lower = {
          ref: "lower",
          head: lowerHead,
          bottom: "main",
          repository: "o/r",
          runId: "5",
          ready: true,
        };
        const gated = skipCheck.parseRecord(
          `format 4\npull request 11\nmerge tree ${sha("e")}\nbase ${lowerHead}\ntested ${sha("e")}\nselection x\nworker-growth y\nbaseline main@${sha("6")}\nabove none\ngate full\n`,
        );
        type Gates = { check?: string | undefined; e2e?: string | undefined };
        const gatedRun = (id: number, gates: Gates) => ({
          id,
          url: `u${id}`,
          record: gated,
          selectDone: true,
          waitingAbove: false,
          gates,
        });
        const queuedDuplicate = { id: 9, url: "u9", selectDone: false, waitingAbove: false };
        const look = (
          runs: ReadonlyArray<skipCheck.RunSeen>,
          more: ReadonlyArray<skipCheck.UpperSeen> = [],
        ) =>
          skipCheck.judge(
            {
              _tag: "Read",
              uppers: [{ pull: 11, head: upperHead, draft: false, runs }, ...more],
            },
            lower,
          );
        const atOnce = (verdict: skipCheck.Verdict) => skipCheck.next(verdict, lower, 0, 0);
        const failsAtOnce = (verdict: skipCheck.Verdict, named: ReadonlyArray<string>) => {
          expect(verdict._tag).toBe("Fail");
          const step = atOnce(verdict);
          expect(step).toMatchObject({ _tag: "Done", decision: { decision: "fail", waited: 0 } });
          if (step._tag !== "Done") return;
          for (const text of named) expect(step.decision.reason).toContain(text);
          expect(step.decision.message).toContain("fix #11");
        };
        const waitsTesting = (verdict: skipCheck.Verdict) => {
          expect(verdict).toMatchObject({ _tag: "Wait", bound: "testing" });
          expect(skipCheck.next(verdict, lower, skipCheck.bounds.selecting + 1, 9)._tag).toBe(
            "Poll",
          );
          expect(skipCheck.next(verdict, lower, skipCheck.bounds.testing - 1, 9)._tag).toBe("Poll");
          expect(skipCheck.next(verdict, lower, skipCheck.bounds.testing, 9)).toMatchObject({
            _tag: "Done",
            decision: { decision: "fail" },
          });
        };

        for (const ended of ["failure", "cancelled"])
          for (const running of ["queued", "in_progress", undefined])
            for (const runs of [
              [gatedRun(2, { check: ended, e2e: running })],
              [queuedDuplicate, gatedRun(2, { check: ended, e2e: running })],
            ])
              failsAtOnce(look(runs), ["u2", `checks / check ended ${ended}`, "cannot pass"]);

        const failedStates = ["failure", "cancelled", "skipped", "timed_out", "missing"];
        const undecided = ["queued", "in_progress", undefined];
        const states = ["success", ...failedStates, ...undecided];
        for (const check of states)
          for (const e2e of states) {
            const verdict = look([gatedRun(2, { check, e2e })]);
            const label = `check ${check}, e2e ${e2e}`;
            if (failedStates.includes(check!) || failedStates.includes(e2e!)) {
              expect(verdict._tag, label).toBe("Fail");
              const [name, state, other] = failedStates.includes(check!)
                ? ["checks / check", check, e2e]
                : ["checks / e2e", e2e, check];
              failsAtOnce(verdict, [
                undecided.includes(other) ? `${name} ended ${state} while` : `${name} ${state}`,
              ]);
            } else if (check === "success" && e2e === "success")
              expect(verdict, label).toMatchObject({ _tag: "Pass", run: "u2", rule: "gate" });
            else waitsTesting(verdict);
          }
        failsAtOnce(look([gatedRun(2, { check: "failure", e2e: "cancelled" })]), [
          "ended with checks / check failure and checks / e2e cancelled",
        ]);

        const cancelled = {
          id: 3,
          url: "u3",
          selectDone: true,
          waitingAbove: false,
          cancelled: true,
        };
        const whole = look([cancelled]);
        expect(whole._tag).toBe("Fail");
        expect(atOnce(whole)).toMatchObject({ _tag: "Done", decision: { waited: 0 } });
        if (whole._tag === "Fail") {
          expect(whole.why).toContain("u3, was cancelled");
          expect(whole.remedy).toContain("gh run rerun 3 --repo o/r");
        }
        waitsTesting(look([gatedRun(4, {}), cancelled]));
        expect(look([cancelled, gatedRun(4, { check: "success", e2e: "success" })])).toMatchObject({
          _tag: "Pass",
          run: "u4",
        });

        expect(look([])).toMatchObject({ _tag: "Wait", bound: "noRun" });
        expect(look([queuedDuplicate])).toMatchObject({ _tag: "Wait", bound: "selecting" });

        const old = gatedRun(1, { check: "failure", e2e: "failure" });
        waitsTesting(look([gatedRun(2, { check: "in_progress" }), old]));
        waitsTesting(look([old, gatedRun(2, { check: "in_progress" })]));
        expect(look([gatedRun(2, { check: "success", e2e: "success" }), old])).toMatchObject({
          _tag: "Pass",
          run: "u2",
        });
        failsAtOnce(look([gatedRun(2, { check: "success", e2e: "failure" }), old]), ["u2", "u1"]);
        failsAtOnce(look([queuedDuplicate, old]), ["u1", "run u9 on the same head has not chosen"]);

        const other = (runs: ReadonlyArray<skipCheck.RunSeen>) => ({
          pull: 12,
          head: sha("8"),
          draft: false,
          runs,
        });
        const mixed = look([old], [other([gatedRun(5, { e2e: "in_progress" })])]);
        waitsTesting(mixed);
        if (mixed._tag === "Wait")
          expect(mixed.why).toContain("u1, ended with checks / check failure");
        expect(
          look([old], [other([gatedRun(5, { check: "success", e2e: "success" })])]),
        ).toMatchObject({ _tag: "Pass", run: "u5" });
        failsAtOnce(look([old], [other([gatedRun(5, { check: "cancelled" })])]), ["u1", "u5"]);
      }),
  );

  it.effect(
    "a ready skip layer reads a failed required check above at its first look, while the run still goes, and a run cancelled as a whole",
    () =>
      Effect.gen(function* () {
        const gated = `format 4\npull request 11\nmerge tree ${sha("e")}\nbase ${lowerHead}\ntested ${sha("e")}\nselection x\nworker-growth y\nbaseline main@${sha("6")}\nabove none\ngate full\n`;
        const ready = skipLayer("main", true);
        const job = (name: string, state: string) =>
          ["queued", "in_progress"].includes(state)
            ? { name, status: state, conclusion: null }
            : { name, status: "completed", conclusion: state };
        const live = { [upperHead]: [{ id: 600, status: "in_progress", conclusion: null }] };
        for (const [check, e2e] of [
          ["failure", "queued"],
          ["cancelled", "in_progress"],
        ] as const) {
          const early = yield* baseline(["above"], ready, {
            ...upper(gated, {
              runJobs: { "600": [job("checks / check", check), job("checks / e2e", e2e)] },
            }),
            upperRuns: {
              [upperHead]: [{ id: 601, status: "queued", conclusion: null }, ...live[upperHead]!],
            },
            selectJobs: { "601": { status: "queued" } },
          });
          expect(early.exitCode).not.toBe(0);
          expect(decided(early.log)).toMatchObject({
            mode: "enforce",
            decision: "fail",
            waited: 0,
          });
          expect(decided(early.log)!.reason).toContain(
            `runs/600, has failed: checks / check ended ${check} while checks / e2e is ${e2e}`,
          );
          expect(decided(early.log)!.message).toContain("once that run has ended, run it again");
        }
        const missing = yield* baseline(["above"], ready, {
          ...upper(gated, { runJobs: { "600": [job("checks / check", "success")] } }),
        });
        expect(missing.exitCode).not.toBe(0);
        expect(decided(missing.log)).toMatchObject({ decision: "fail", waited: 0 });
        expect(decided(missing.log)!.reason).toContain(
          "ended with checks / check success and checks / e2e missing",
        );
        const cancelled = yield* baseline(["above"], ready, {
          ...upper(gated),
          upperRuns: { [upperHead]: [{ id: 600, conclusion: "cancelled" }] },
        });
        expect(cancelled.exitCode).not.toBe(0);
        expect(decided(cancelled.log)).toMatchObject({ decision: "fail", waited: 0 });
        expect(decided(cancelled.log)!.reason).toContain("runs/600, was cancelled");
        expect(decided(cancelled.log)!.message).toContain("gh run rerun 600");
        expect(cancelled.calls.some((call) => call.startsWith("run download"))).toBe(false);
      }),
  );

  it.effect("one constant decides observe or enforce, and the bounds compose", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      expect(skipCheck.enforcing({ ready: true })).toBe(true);
      expect(skipCheck.enforcing({ ready: false })).toBe(false);
      const lower = {
        ref: "lower",
        head: lowerHead,
        bottom: "main",
        repository: "o/r",
        runId: "5",
        ready: false,
      };
      const stale = skipCheck.judge(
        {
          _tag: "Read",
          uppers: [
            {
              pull: 11,
              head: upperHead,
              draft: false,
              runs: [
                {
                  id: 1,
                  url: "u",
                  record: skipCheck.parseRecord(laundered),
                  selectDone: true,
                  waitingAbove: false,
                },
              ],
            },
          ],
        },
        lower,
      );
      expect(skipCheck.next(stale, lower, 239, 9)._tag).toBe("Poll");
      const done = skipCheck.next(stale, lower, 240, 9);
      expect(done._tag).toBe("Done");
      if (done._tag !== "Done") return;
      expect(done.decision.decision).toBe("fail");
      const decided = { _tag: "Decided" as const, decision: done.decision };
      expect(skipCheck.fails(decided, true)).toBe(true);
      expect(skipCheck.fails(decided, false)).toBe(false);
      expect(
        skipCheck.fails(
          { _tag: "Decided", decision: { ...done.decision, decision: "pass" } },
          true,
        ),
      ).toBe(false);
      expect(
        skipCheck.judge({ _tag: "Unread", why: "x" }, lower, {
          _tag: "Wait",
          bound: "selecting",
          why: "y",
        }),
      ).toMatchObject({ _tag: "Wait", bound: "selecting" });
      const polls = Array.from({ length: 30 }, (_, index) => skipCheck.pollAfter(index));
      expect(polls.slice(0, 5)).toEqual([20, 30, 45, 60, 60]);
      expect(Math.min(...polls)).toBeGreaterThanOrEqual(20);
      expect(skipCheck.bounds).toEqual({
        stale: 240,
        noRun: 240,
        selecting: 900,
        chained: 1200,
        testing: 3000,
      });
      expect(skipCheck.bounds.chained - skipCheck.bounds.selecting).toBeGreaterThanOrEqual(5 * 60);
      expect(skipCheck.bounds.testing - skipCheck.bounds.chained).toBeGreaterThanOrEqual(5 * 60);
      const checks = yield* fs.readFileString(".github/workflows/checks.yml");
      const select = checks.slice(checks.indexOf("  select:"), checks.indexOf("\n  static:"));
      const timeout = Number(select.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
      expect(timeout * 60).toBeGreaterThanOrEqual(180 + skipCheck.bounds.testing + 5 * 60);
      expect(select).toContain(`          RECORD_FORMAT: "${skipCheck.recordFormat}"\n`);
    }),
  );

  it.effect(
    "the skip layer's check runs before its record, and a failed check hands no skip on",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checks = yield* fs.readFileString(".github/workflows/checks.yml");
        expect(checks).toContain(
          "      skip: ${{ steps.repeat.outputs.of == '' && steps.above.outcome == 'success' && steps.select.outputs.skip || '' }}\n",
        );
        const select = checks.slice(checks.indexOf("  select:"), checks.indexOf("\n  static:"));
        const above = select.indexOf("        id: above\n");
        expect(above).toBeGreaterThan(select.indexOf("        id: baseline\n"));
        expect(above).toBeLessThan(select.indexOf("        id: tested\n"));
        expect(select).toContain(
          "        if: github.event_name == 'pull_request' && steps.select.outputs.skip == 'true'\n",
        );
        expect(select).toContain(
          "          BASELINE_BRANCH: ${{ steps.baseline.outputs.branch }}\n",
        );
        expect(select).toContain("        run: node scripts/ci/worker-baseline.ts above\n");
        const tested = select.slice(select.indexOf("        id: tested\n"));
        const condition = tested.match(/^ {8}if: (.*)$/m)?.[1] ?? "";
        expect(condition).toBe(
          "github.event_name == 'pull_request' && steps.select.outputs.selection != '' && steps.select.outputs.worker-growth != ''",
        );
        expect(tested).toContain(
          "          ABOVE: ${{ steps.above.outputs.decision || 'none' }}\n",
        );
        expect(tested).toContain("          GATE: ${{ steps.select.outputs.gate }}\n");
        expect(select).toContain("          LOWER_DRAFT: ${{ steps.select.outputs.draft }}\n");
        expect(tested).toContain("          tested=$(git rev-parse HEAD)\n");
        expect(select).toContain(
          `printf 'format %s\\npull request %s\\nmerge tree %s\\nbase %s\\ntested %s\\nselection %s\\nworker-growth %s\\nbaseline %s\\nabove %s\\ngate %s\\n' "$RECORD_FORMAT" "$PULL" "$tree" "$BASE_SHA" "$tested" "$SELECTION" "$WORKER_GROWTH" "$BASELINE" "$ABOVE" "$GATE"`,
        );
        expect(checks).toContain(
          'git rev-parse HEAD > "$GITHUB_WORKSPACE/.local/worker-uploads-base/baseline-commit.txt"',
        );
      }),
  );

  const pushed = (added: number, merged?: ReadonlyArray<{ number: number; body: string }>) =>
    check({
      uploads: { ...main, api: { bytes: main.api!.bytes + added, budget: 6_000_000 } },
      baseline: "main at 82eda7c59",
      ...(merged === undefined ? {} : { merged }),
    });
  const allows = (line: string) => `Adds a route.\n\n\`\`\`worker-growth\n${line}\n\`\`\`\n`;

  it.effect(
    "a push to main is held to the rule, each Worker allowed what the pull requests it merges allow",
    () =>
      Effect.gen(function* () {
        expect((yield* pushed(50_000, [{ number: 1, body: "No block." }])).exitCode).toBe(0);
        const allowed = yield* pushed(60_000, [
          { number: 4344, body: allows("api +60,000: v1's MCP URLs") },
        ]);
        expect(allowed.exitCode, allowed.log).toBe(0);
        expect(allowed.summary).toContain("Allowed up to 60,000: #4344: v1's MCP URLs");
        const stack = yield* pushed(90_000, [
          { number: 2, body: allows("api +40,000: the first half") },
          { number: 3, body: allows("api +50,000: the second half") },
        ]);
        expect(stack.exitCode, stack.log).toBe(0);
        const grew = yield* pushed(60_001, [{ number: 4583, body: "No block." }]);
        expect(grew.exitCode).toBe(1);
        expect(grew.errors).toEqual([
          "::error title=api Worker grew on main without an allowance::This push adds +60,001 bytes to api over main at 82eda7c59, about 2 ms on each cold start; the pull requests it merges (#4583) allow none. Put the line `api +60,001: <why it is worth the cold-start time>` in a worker-growth block of the merged pull request's description, with your reason, and run this failed job again, which reads the descriptions afresh; or shrink api in a new pull request. See the job summary for what grew.",
        ]);
        expect(
          (yield* pushed(70_000, [{ number: 5, body: allows("api +60,000: most of it") }]))
            .errors[0],
        ).toContain("the pull requests it merges (#5) allow 60,000.");
        expect((yield* pushed(60_001, [])).errors[0]).toContain(
          "it merges no pull request, so no description allows it.",
        );
      }),
  );

  it.effect("a push to main never fails for a reason that is not growth", () =>
    Effect.gen(function* () {
      const missing = yield* check({
        uploads: { ...main, api: { bytes: main.api!.bytes + 200_000, budget: 6_000_000 } },
        base: "missing",
        merged: [],
      });
      expect(missing.exitCode, missing.log).toBe(0);
      expect((yield* pushed(-120_000, [])).exitCode).toBe(0);
      const unread = yield* pushed(10_000, [{ number: 6, body: allows("api: no size") }]);
      expect(unread.exitCode, unread.log).toBe(0);
      expect(unread.log).toContain(
        "::notice title=Worker sizes::A merged pull request's allowance: `#6: api: no size` is not a Worker, a size and a reason",
      );
      expect((yield* pushed(200_000)).exitCode).toBe(0);
    }),
  );

  it.effect(
    "the merged pull requests are read from the push's commits, and nothing unread fails the job",
    () =>
      Effect.gen(function* () {
        const env = { BEFORE_SHA: sha("1"), HEAD_SHA: sha("2") };
        const answers: GitHubAnswers = {
          pushCommits: [sha("3"), sha("4"), sha("5")],
          commitPulls: { [sha("3")]: [4574], [sha("4")]: [4575] },
          pullBodies: { "4574": "skip layer", "4575": allows("api +60,000: the reason") },
        };
        const read = yield* baseline(["merged", "<file>"], env, answers);
        expect(read.exitCode, read.log).toBe(0);
        expect(read.outputs).toMatchObject({ read: "true", pulls: "#4574, #4575" });
        expect(JSON.parse(read.file!)).toEqual([
          { number: 4574, body: "skip layer" },
          { number: 4575, body: allows("api +60,000: the reason").trim() },
        ]);
        expect(read.log).toContain(
          "::notice title=Worker sizes::555555555 is a commit no pull request merged, so it allows no growth.",
        );
        const down = yield* baseline(["merged", "<file>"], env, { ...answers, failPush: true });
        expect(down.exitCode, down.log).toBe(0);
        expect(down.outputs).toEqual({ read: "false" });
        expect(down.file).toBeUndefined();
        expect(down.log).toContain("could not be read, so its growth is reported and not checked");
        const body = yield* baseline(["merged", "<file>"], env, {
          ...answers,
          pullBodies: { "4574": "skip layer" },
        });
        expect(body.outputs).toEqual({ read: "false" });
        const fs = yield* FileSystem.FileSystem;
        const checks = yield* fs.readFileString(".github/workflows/checks.yml");
        expect(checks).toContain(
          "        if: github.event_name == 'push'\n        env:\n          GH_TOKEN: ${{ github.token }}\n          BEFORE_SHA: ${{ github.event.before }}\n          HEAD_SHA: ${{ github.sha }}\n        run: |\n          if ! node scripts/ci/worker-baseline.ts merged \"$RUNNER_TEMP/merged-pull-requests.json\"; then\n",
        );
        expect(checks).toContain("          MERGED: ${{ steps.merged.outputs.file }}\n");
        expect(checks).toContain('${MERGED:+--merged "$MERGED"}');
        const ci = yield* fs.readFileString(".github/workflows/ci.yml");
        expect(ci).not.toContain("edited");
        expect(ci).not.toContain("run-name");
      }),
  );

  it.effect("the last 40 lower-layer pushes, replayed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pushes = JSON.parse(
        yield* fs.readFileString("e2e/skip-check-replay.json"),
      ) as ReadonlyArray<Push>;
      const results = Object.fromEntries(
        pushes.map((push) => [`#${push.lower} ${push.run}/${push.attempt}`, replay(push)]),
      );
      expect(results).toEqual(replayed);
    }),
  );
});

interface Push {
  readonly lower: number;
  readonly run: number;
  readonly attempt: number;
  readonly ref: string;
  readonly head: string;
  readonly bottom: string;
  readonly uppers: ReadonlyArray<{ readonly pull: number; readonly head: string }>;
  readonly runs: ReadonlyArray<{
    readonly id: number;
    readonly pull: number;
    readonly head: string;
    readonly fork?: boolean;
    readonly cancelledAt?: number;
    readonly phases: ReadonlyArray<{
      readonly at: number;
      readonly selectDone: boolean;
      readonly record?: string;
    }>;
  }>;
}

const replay = (push: Push) => {
  const lower = {
    ref: push.ref,
    head: push.head,
    bottom: push.bottom,
    repository: "UsefulSoftwareCo/executor-next",
    runId: String(push.run),
    ready: false,
  };
  const look = (at: number): skipCheck.Observation => ({
    _tag: "Read",
    uppers: push.uppers.map((upper) => {
      const started = push.runs
        .filter(
          (run) =>
            run.pull === upper.pull &&
            run.head === upper.head &&
            run.fork !== true &&
            run.phases[0]!.at <= at,
        )
        .toSorted((a, b) => b.id - a.id);
      const cancelled = (run: (typeof started)[number]) =>
        run.cancelledAt !== undefined && run.cancelledAt <= at;
      const live = started.filter((run) => !cancelled(run));
      const newest = started[0];
      return {
        pull: upper.pull,
        head: upper.head,
        draft: false,
        runs:
          live.length === 0 && newest !== undefined
            ? [
                {
                  id: newest.id,
                  url: String(newest.id),
                  selectDone: true,
                  waitingAbove: false,
                  cancelled: true,
                },
              ]
            : live.map((run) => {
                const phase = run.phases.findLast((each) => each.at <= at)!;
                return {
                  id: run.id,
                  url: String(run.id),
                  record:
                    phase.record === undefined ? undefined : skipCheck.parseRecord(phase.record),
                  selectDone: phase.selectDone,
                  waitingAbove: false,
                };
              }),
      };
    }),
  });
  let previous: skipCheck.Verdict | undefined;
  for (let at = 0, polls = 0; ; polls += 1) {
    const verdict = skipCheck.judge(look(at), lower, previous);
    previous = verdict;
    const step = skipCheck.next(verdict, lower, at, polls);
    if (step._tag === "Done")
      return `${step.decision.decision === "pass" ? (step.decision.oldFormat ? "old format" : "pass") : "fail"} at ${Math.round(at)} s`;
    at += step.after;
  }
};

const replayed: Record<string, string> = {
  "#4364 43793324814/1": "old format at 20 s",
  "#4364 43799666868/2": "old format at 20 s",
  "#4436 43768234280/1": "old format at 20 s",
  "#4436 43790114596/1": "old format at 20 s",
  "#4437 43768232548/1": "old format at 20 s",
  "#4437 43768233846/1": "old format at 0 s",
  "#4437 43790115295/1": "old format at 20 s",
  "#4437 43790115574/1": "old format at 0 s",
  "#4438 43768232720/1": "old format at 20 s",
  "#4438 43768233035/1": "old format at 0 s",
  "#4526 43764086735/1": "old format at 20 s",
  "#4526 43796363272/1": "old format at 20 s",
  "#4535 43764086047/1": "old format at 20 s",
  "#4535 43764086626/1": "old format at 0 s",
  "#4535 43793228808/1": "old format at 20 s",
  "#4535 43793228984/1": "old format at 0 s",
  "#4535 43796363943/1": "old format at 20 s",
  "#4535 43796364777/1": "old format at 0 s",
  "#4543 43771845869/1": "old format at 20 s",
  "#4544 43771846274/2": "old format at 0 s",
  "#4544 43771846802/3": "old format at 0 s",
  "#4548 43771846978/1": "old format at 20 s",
  "#4548 43771847447/1": "old format at 0 s",
  "#4551 43771845232/1": "old format at 20 s",
  "#4551 43771846053/1": "old format at 0 s",
  "#4557 43764101615/1": "old format at 20 s",
  "#4557 43793229529/1": "old format at 20 s",
  "#4557 43793230202/1": "old format at 0 s",
  "#4557 43796364217/1": "old format at 20 s",
  "#4559 43770386335/1": "old format at 50 s",
  "#4562 43771920578/1": "old format at 20 s",
  "#4562 43783348587/1": "old format at 20 s",
  "#4565 43779277043/1": "fail at 240 s",
  "#4568 43781460811/1": "old format at 20 s",
  "#4568 43794794693/1": "old format at 20 s",
  "#4574 43786864732/1": "old format at 20 s",
  "#4574 43788608204/1": "old format at 20 s",
  "#4574 43797130175/1": "pass at 20 s",
  "#4582 43793923058/1": "old format at 20 s",
  "#4586 43795625424/1": "fail at 240 s",
};
