/**
 * The Deploy workflow's decide job skips the deploy for a push whose changes since the deploy that
 * started last, when it succeeded, all lie in paths no deploy reads. These cases run
 * `node apps/hosted/cloud/scripts/deploy-decision.ts` as a process with the job's environment,
 * in a temporary repository laid out as this one is, against a stub of GitHub's Actions API that
 * records which runs deployed. They read the outputs file and the job summary it writes, as GitHub
 * Actions does.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer } from "node:http";

const repository = "owner/repository";
const script = "apps/hosted/cloud/scripts/deploy-decision.ts";
/** The deploy step's name, which the deploy history looks for. */
const deployStep = "Deploy analytics and the v2 stage";

/** The root manifest, as this repository's is laid out: workspaces, scripts, dependencies. */
const rootManifest = (
  change: {
    readonly scripts?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
  } = {},
) =>
  JSON.stringify(
    {
      name: "root",
      workspaces: [
        "packages/*",
        "apps/hosted/cloud",
        "apps/hosted/cloud/web",
        "apps/marketing",
        "apps/docs",
        "apps/local",
        "e2e/viewer",
        "apps/hosted/testing",
      ],
      scripts: {
        build: "node scripts/build.ts",
        "e2e:one": "vitest run --config e2e/one.config.ts",
        ...change.scripts,
      },
      devDependencies: { typescript: "5.9.3", ...change.devDependencies },
    },
    null,
    2,
  );

/** A small repository laid out as this one is: packages, and the paths no deploy reads. */
const files: Record<string, string> = {
  "package.json": rootManifest(),
  "bun.lock": "lock 1\n",
  "tsconfig.json": "{}\n",
  "README.md": "Synthetic readme.\n",
  "apps/hosted/cloud/package.json": JSON.stringify({
    name: "cloud",
    dependencies: { lib: "workspace:*" },
  }),
  "apps/hosted/cloud/src/main.ts": "export const main = 1;\n",
  "apps/hosted/cloud/web/package.json": JSON.stringify({ name: "web" }),
  "apps/marketing/package.json": JSON.stringify({ name: "marketing" }),
  "apps/docs/package.json": JSON.stringify({ name: "docs" }),
  "apps/docs/content/page.mdx": "Synthetic page.\n",
  "packages/apps/package.json": JSON.stringify({ name: "apps" }),
  "packages/lib/package.json": JSON.stringify({ name: "lib", devDependencies: { deep: "*" } }),
  "packages/lib/src/lib.ts": "export const lib = 1;\n",
  "packages/deep/package.json": JSON.stringify({ name: "deep" }),
  "packages/deep/src/deep.ts": "export const deep = 1;\n",
  "packages/other/package.json": JSON.stringify({ name: "other" }),
  "packages/other/src/other.ts": "export const other = 1;\n",
  "apps/local/package.json": JSON.stringify({ name: "local" }),
  "apps/local/src/local.ts": "export const local = 1;\n",
  "e2e/tests/example.spec.ts": "export {};\n",
  "e2e/viewer/package.json": JSON.stringify({ name: "viewer" }),
  "e2e/viewer/main.tsx": "export {};\n",
  "apps/hosted/testing/package.json": JSON.stringify({ name: "testing" }),
  "apps/hosted/testing/cli.ts": "export {};\n",
  "notes/ci.md": "Synthetic note.\n",
  "patches/example.patch": "patch 1\n",
  ".github/workflows/checks.yml": "name: Checks\n",
  ".github/workflows/deploy.yml": "name: Deploy\n",
  ".github/actions/setup/action.yml": "name: Setup\n",
  "scripts/ci/tool.ts": "export {};\n",
  "scripts/releases/apps-published.ts": "export {};\n",
};

/**
 * How one attempt of a Deploy run went for its commit: its deploy step succeeded, failed, was
 * cancelled or is still running; its deploy job was skipped; its deploy job started and lists no
 * step yet; or the attempt was cancelled while it waited, before it had any job.
 */
type Deployed = "success" | "failure" | "cancelled" | "running" | "skipped" | "unlisted" | "never";

interface Attempt {
  readonly deployed: Deployed;
  /** Hours after the run's creation that this attempt started. */
  readonly afterHours: number;
}

interface Run {
  readonly id: number;
  readonly sha: string;
  readonly createdAt: string;
  readonly event: "push" | "workflow_dispatch";
  /** Its attempts, first to last. */
  readonly attempts: ReadonlyArray<Attempt>;
  /** The deploy job's name, when a run named it otherwise. */
  readonly jobName?: string;
}

const hour = 3_600_000;
const at = (time: string, offset: number) => new Date(Date.parse(time) + offset).toISOString();

/** One attempt's jobs as GitHub lists them: the decide job, then the deploy job. */
const jobsOf = (run: Run, attempt: Attempt) => {
  if (attempt.deployed === "never") return [];
  const created = at(run.createdAt, attempt.afterHours * hour);
  const started = at(created, 30_000);
  const finished = at(created, 90_000);
  const name = run.jobName ?? "deploy";
  const decide = {
    name: "decide",
    conclusion: "success",
    created_at: created,
    started_at: created,
    steps: [],
  };
  const step = (status: string, conclusion: string | null) => ({
    name: deployStep,
    status,
    conclusion,
    started_at: started,
    completed_at: status === "completed" ? finished : null,
  });
  switch (attempt.deployed) {
    case "skipped":
      // A job whose condition was false: no steps, never started.
      return [
        decide,
        { name, conclusion: "skipped", created_at: created, started_at: null, steps: [] },
      ];
    case "unlisted":
      return [
        decide,
        { name, conclusion: null, created_at: created, started_at: started, steps: [] },
      ];
    case "running":
      return [
        decide,
        {
          name,
          conclusion: null,
          created_at: created,
          started_at: started,
          steps: [step("in_progress", null)],
        },
      ];
    default:
      return [
        decide,
        {
          name,
          conclusion: attempt.deployed,
          created_at: created,
          started_at: started,
          steps: [step("completed", attempt.deployed)],
        },
      ];
  }
};

/** GitHub's Actions API for these runs: the workflow, its runs by creation time, each run's jobs. */
const stubGitHub = (
  runs: ReadonlyArray<Run>,
  down: boolean,
  /** The root manifest at each commit, for GitHub's contents API. */
  manifests: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const workflowCreated = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const routes = HttpRouter.add(
      "GET",
      "*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (down) return HttpServerResponse.empty({ status: 503 });
        const url = new URL(request.url, "http://stub");
        const path = url.pathname.replace(/^\//, "");
        if (path === `repos/${repository}/actions/workflows/deploy.yml`)
          return HttpServerResponse.jsonUnsafe({ created_at: workflowCreated });
        if (path === `repos/${repository}/contents/package.json`) {
          const manifest = manifests[url.searchParams.get("ref") ?? ""];
          return manifest === undefined
            ? HttpServerResponse.empty({ status: 404 })
            : HttpServerResponse.jsonUnsafe({
                content: Buffer.from(manifest)
                  .toString("base64")
                  .replace(/(.{60})/g, "$1\n"),
                encoding: "base64",
              });
        }
        if (path === `repos/${repository}/actions/workflows/deploy.yml/runs`) {
          const [from = "", to = ""] = (url.searchParams.get("created") ?? "").split("..");
          const listed = runs.filter(
            (run) =>
              run.createdAt.slice(0, 19) >= from.slice(0, 19) &&
              run.createdAt.slice(0, 19) <= to.slice(0, 19),
          );
          return HttpServerResponse.jsonUnsafe({
            total_count: listed.length,
            workflow_runs: listed.map((run) => {
              const last = run.attempts.at(-1)!;
              return {
                id: run.id,
                run_attempt: run.attempts.length,
                event: run.event,
                head_sha: run.sha,
                status: last.deployed === "running" ? "in_progress" : "completed",
                created_at: run.createdAt,
                updated_at: at(run.createdAt, last.afterHours * hour + 120_000),
              };
            }),
          });
        }
        const jobs = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(
          path,
        );
        const run = runs.find((candidate) => String(candidate.id) === jobs?.[1]);
        const attempt = run?.attempts[Number(jobs?.[2]) - 1];
        if (run !== undefined && attempt !== undefined)
          return HttpServerResponse.jsonUnsafe({ jobs: jobsOf(run, attempt) });
        return HttpServerResponse.empty({ status: 404 });
      }),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Expected a TCP stub");
    return `http://127.0.0.1:${server.address.port}`;
  });

/** One earlier Deploy run: how its first attempt went, and its later attempts. */
interface Earlier {
  readonly deployed: Deployed;
  readonly event?: "push" | "workflow_dispatch";
  readonly reruns?: ReadonlyArray<Attempt>;
  readonly jobName?: string;
}

/**
 * Run the decision in a fresh repository. The first commit was deployed (`base` changes how);
 * `history` commits one change per earlier Deploy run, an hour apart; `change` is the pushed
 * commit's own change.
 */
const decide = (input: {
  readonly base?: Omit<Earlier, "deployed">;
  readonly history: ReadonlyArray<Earlier & { readonly change: Record<string, string> }>;
  readonly change: Record<string, string | null>;
  readonly event?: "push" | "workflow_dispatch";
  readonly down?: boolean;
  /** Point the last deploy at a commit the repository does not hold. */
  readonly unknownBase?: boolean;
  /** Deploy the pushed commit itself before this run, as a rerun of it finds. */
  readonly rerun?: boolean;
  /** The run attempt, above 1 when someone re-runs the run. */
  readonly attempt?: number;
  /** Point the job summary at a path that cannot be written. */
  readonly unwritableSummary?: boolean;
  /** GitHub answers 404 for the root manifest at every commit but the pushed one. */
  readonly noBaseManifest?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkout = path.resolve(".");
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-deploy-decision-" });
    const git = (...args: ReadonlyArray<string>) =>
      processes.string(
        ChildProcess.make(
          "git",
          ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.test", ...args],
          { cwd: directory },
        ),
      );
    const write = (changes: Record<string, string | null>) =>
      Effect.forEach(Object.entries(changes), ([file, text]) =>
        text === null
          ? fs.remove(path.join(directory, file))
          : fs
              .makeDirectory(path.dirname(path.join(directory, file)), { recursive: true })
              .pipe(Effect.andThen(fs.writeFileString(path.join(directory, file), text))),
      );
    const commit = (message: string) =>
      git("add", "-A").pipe(
        Effect.andThen(git("commit", "-q", "--allow-empty", "-m", message)),
        Effect.andThen(git("rev-parse", "HEAD")),
        Effect.map((sha) => sha.trim()),
      );
    yield* git("init", "-q", "-b", "main");
    yield* write(files);
    const runs: Array<Run> = [];
    let time = Date.now() - 10 * hour;
    const record = (sha: string, earlier: Earlier) => {
      time += hour;
      runs.push({
        id: 1000 + runs.length,
        sha,
        createdAt: new Date(time).toISOString(),
        event: earlier.event ?? "push",
        attempts: [{ deployed: earlier.deployed, afterHours: 0 }, ...(earlier.reruns ?? [])],
        ...(earlier.jobName === undefined ? {} : { jobName: earlier.jobName }),
      });
    };
    record(yield* commit("Base"), { ...input.base, deployed: "success" });
    for (const [index, earlier] of input.history.entries()) {
      yield* write(earlier.change);
      record(yield* commit(`Earlier ${index}`), earlier);
    }
    yield* write(input.change);
    const head = yield* commit("Head");
    if (input.rerun === true) record(head, { deployed: "success" });
    if (input.unknownBase === true) record("0".repeat(40), { deployed: "success" });
    const manifests: Record<string, string> = {};
    for (const sha of [...runs.map((run) => run.sha), head])
      if (sha === head || input.noBaseManifest !== true)
        manifests[sha] = yield* git("show", `${sha}:package.json`);
    const api = yield* stubGitHub(runs, input.down === true, manifests);
    const output = path.join(directory, "output");
    const summary = path.join(directory, "summary");
    yield* fs.writeFileString(output, "");
    if (input.unwritableSummary === true) yield* fs.makeDirectory(summary);
    else yield* fs.writeFileString(summary, "");
    const child = yield* processes.spawn(
      ChildProcess.make("node", [path.join(checkout, script)], {
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? "",
          GITHUB_API_URL: api,
          GITHUB_TOKEN: "synthetic-token",
          GITHUB_REPOSITORY: repository,
          GITHUB_SHA: head,
          GITHUB_EVENT_NAME: input.event ?? "push",
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: String(input.attempt ?? 1),
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
        extendEnv: false,
        stdout: "pipe",
        stderr: "inherit",
      }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    const outputs = new Map(
      (yield* fs.readFileString(output))
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return {
      exitCode,
      deploy: outputs.get("deploy"),
      base: outputs.get("base"),
      summary: input.unwritableSummary === true ? "" : yield* fs.readFileString(summary),
      stdout,
      first: runs[0]!.sha,
      head,
    };
  }).pipe(Effect.scoped);

layer(NodeServices.layer)("Deploy decision", (it) => {
  it.effect("a push that changes only tests, notes, documents or other workflows skips", () =>
    Effect.gen(function* () {
      const run = yield* decide({
        history: [],
        change: {
          "e2e/tests/example.spec.ts": "export const changed = 1;\n",
          "notes/ci.md": "Changed note.\n",
          "README.md": "Changed readme.\n",
          ".github/workflows/checks.yml": "name: Changed checks\n",
          "e2e/support/helper.ts": "export const helper = 1;\n",
        },
      });
      expect(run.exitCode).toBe(0);
      expect(run.deploy).toBe("false");
      expect(run.base).toBe(run.first);
      expect(run.summary).toContain(
        "**Skipped:** every change since the last deploy lies in paths no deploy reads",
      );
      expect(run.summary).toContain(`Base: \`${run.first}\``);
      expect(run.summary).toContain("None of the 5 changed files is a deploy input");
    }),
  );

  it.effect("a change to anything else deploys, and names the files", () =>
    Effect.gen(function* () {
      const inputs: Record<string, Record<string, string | null>> = {
        "a deploy root": { "apps/hosted/cloud/src/main.ts": "export const main = 2;\n" },
        "a package a root depends on": { "packages/lib/src/lib.ts": "export const lib = 2;\n" },
        "a package two dependencies away": {
          "packages/deep/src/deep.ts": "export const deep = 2;\n",
        },
        "the site's docs": { "apps/docs/content/page.mdx": "Changed page.\n" },
        "the lockfile": { "bun.lock": "lock 2\n" },
        "a root-level configuration file": { "tsconfig.json": "{ }\n" },
        "a dependency patch": { "patches/example.patch": "patch 2\n" },
        "the Deploy workflow": { ".github/workflows/deploy.yml": "name: Deploy changed\n" },
        "the setup action it runs": { ".github/actions/setup/action.yml": "name: Changed\n" },
        "a script the deploy job runs": {
          "scripts/releases/apps-published.ts": "export const changed = 1;\n",
        },
        "the manifest of a package no root depends on": {
          "packages/other/package.json": JSON.stringify({ name: "other", version: "2.0.0" }),
        },
        "another package": { "packages/other/src/other.ts": "export const other = 2;\n" },
        "another application": { "apps/local/src/local.ts": "export const local = 2;\n" },
        "a CI script": { "scripts/ci/tool.ts": "export const changed = 1;\n" },
        "a release note": { ".changeset/change.md": "Synthetic release note.\n" },
        "a package manifest under a listed path": {
          "e2e/tools/package.json": JSON.stringify({ name: "tools" }),
        },
      };
      // The decision classifies each changed file on its own, so one push with every input, and
      // a note beside them, names each input among the matched files and only those. A deleted
      // file changes the same path as the first input, so it is a push of its own.
      const pushes = [
        Object.assign({}, ...Object.values(inputs)) as Record<string, string | null>,
        { "apps/hosted/cloud/src/main.ts": null },
      ];
      const runs = yield* Effect.forEach(
        pushes,
        (change) =>
          decide({ history: [], change: { ...change, "notes/ci.md": "Changed note.\n" } }),
        { concurrency: "unbounded" },
      );
      for (const [index, run] of runs.entries()) {
        const files = Object.keys(pushes[index]!);
        expect(run.deploy).toBe("true");
        expect(run.summary).toContain(
          "**Deploying:** files a deploy may depend on changed since the last deploy",
        );
        expect(run.summary).toContain(
          `${files.length} of the ${files.length + 1} changed files may be deploy inputs:`,
        );
        for (const file of files) expect(run.summary, file).toContain(`- \`${file}\``);
        expect(run.summary).not.toContain("`notes/ci.md`");
      }
    }),
  );

  it.effect("the base is the last commit deployed, not the one before the push", () =>
    Effect.gen(function* () {
      // A deploy root changed in a run whose deploy job was skipped: it never went live, so a push
      // of tests alone still deploys the change. (A deploy that started and failed is the next case.)
      for (const deployed of ["skipped"] as const) {
        const run = yield* decide({
          history: [
            { change: { "apps/hosted/cloud/src/main.ts": "export const main = 3;\n" }, deployed },
          ],
          change: { "e2e/tests/example.spec.ts": "export const changed = 1;\n" },
        });
        expect(run.deploy, deployed).toBe("true");
        expect(run.base, deployed).toBe(run.first);
        expect(run.summary, deployed).toContain("`apps/hosted/cloud/src/main.ts`");
      }
      // Once a later run deploys the change, only what came after it counts.
      const run = yield* decide({
        history: [
          {
            change: { "apps/hosted/cloud/src/main.ts": "export const main = 3;\n" },
            deployed: "success",
          },
        ],
        change: { "e2e/tests/example.spec.ts": "export const changed = 1;\n" },
      });
      expect(run.deploy).toBe("false");
      expect(run.base).not.toBe(run.first);
    }),
  );

  it.effect("every doubt deploys", () =>
    Effect.gen(function* () {
      const testsOnly = { "e2e/tests/example.spec.ts": "export const changed = 1;\n" };
      const cases = {
        "a manual dispatch": yield* decide({
          history: [],
          change: testsOnly,
          event: "workflow_dispatch",
        }),
        "GitHub unavailable": yield* decide({ history: [], change: testsOnly, down: true }),
        "a last deployed commit git does not hold": yield* decide({
          history: [],
          change: testsOnly,
          unknownBase: true,
        }),
        "a rerun of the deployed commit": yield* decide({
          history: [],
          change: testsOnly,
          rerun: true,
        }),
      };
      for (const [name, run] of Object.entries(cases)) {
        expect(run.exitCode, name).toBe(0);
        expect(run.deploy, name).toBe("true");
        expect(run.summary, name).toMatch(/\*\*(Deploying|Could not decide, so deploying):\*\*/);
      }
      expect(cases["a manual dispatch"].summary).toContain("a manual run always deploys");
      expect(cases["GitHub unavailable"].summary).toContain("**Could not decide, so deploying:**");
      expect(cases["a last deployed commit git does not hold"].summary).toContain(
        "**Could not decide, so deploying:**",
      );
      expect(cases["a rerun of the deployed commit"].summary).toContain("deploys it again");
    }),
  );

  it.effect("a deploy that started and did not succeed is never compared past", () =>
    Effect.gen(function* () {
      // A deploy root changes in a run whose deploy step fails partway, is cancelled or is still
      // running, and the push after it reverts the change: its tree is the last successful
      // deploy's, but production may hold any part of the deploy in between.
      for (const deployed of ["failure", "cancelled", "running"] as const) {
        const run = yield* decide({
          history: [
            { change: { "apps/hosted/cloud/src/main.ts": "export const main = 3;\n" }, deployed },
          ],
          change: {
            "apps/hosted/cloud/src/main.ts": "export const main = 1;\n",
            "e2e/tests/example.spec.ts": "export const changed = 1;\n",
          },
        });
        expect(run.exitCode, deployed).toBe(0);
        expect(run.deploy, deployed).toBe("true");
        expect(run.summary, deployed).toContain("**Deploying:**");
        expect(run.summary, deployed).toContain("did not succeed");
      }
      // A deploy job that was skipped started nothing, so the deploy before it is still the base.
      const run = yield* decide({
        history: [
          {
            change: { "e2e/tests/example.spec.ts": "export const one = 1;\n" },
            deployed: "skipped",
          },
        ],
        change: { "e2e/tests/example.spec.ts": "export const two = 2;\n" },
      });
      expect(run.deploy).toBe("false");
      expect(run.base).toBe(run.first);
    }),
  );

  it.effect("a path the rule does not list deploys", () =>
    Effect.gen(function* () {
      // Read by deploy steps from outside any deploy package: the framework reference reads a
      // playground example, and the docs import the release configuration by relative path.
      // A path nobody has thought about deploys too.
      for (const file of [
        "playground/demo-apps/live-inbox/index.ts",
        "scripts/releases/config.ts",
        "scripts/releases/published.ts",
        "tools/unknown/file.ts",
        "LICENSE",
        "apps/hosted/testing/package.json",
        "apps/hosted/testing/binding.gyp",
      ]) {
        const run = yield* decide({
          history: [],
          change: { [file]: "export const changed = 1;\n", "notes/ci.md": "Changed note.\n" },
        });
        expect(run.deploy, file).toBe("true");
        expect(run.summary, file).toContain(`- \`${file}\``);
        expect(run.summary, file).not.toContain("`notes/ci.md`");
      }
    }),
  );

  it.effect("a re-run of a run deploys", () =>
    Effect.gen(function* () {
      // Someone who changes a secret and re-runs the newest run must get a deploy.
      const run = yield* decide({
        history: [],
        change: { "e2e/tests/example.spec.ts": "export const changed = 1;\n" },
        attempt: 2,
      });
      expect(run.deploy).toBe("true");
      expect(run.summary).toContain("attempt 2");
    }),
  );

  it.effect("paths git would quote are read as they are", () =>
    Effect.gen(function* () {
      const input = yield* decide({
        history: [],
        change: { "apps/hosted/cloud/src/café.ts": "export const café = 1;\n" },
      });
      expect(input.deploy).toBe("true");
      expect(input.summary).toContain("- `apps/hosted/cloud/src/café.ts`");
      const listed = yield* decide({
        history: [],
        change: { "e2e/tests/café.spec.ts": "export {};\n" },
      });
      expect(listed.deploy).toBe("false");
    }),
  );

  it.effect("a change outside the list deploys whatever the workspace patterns say", () =>
    Effect.gen(function* () {
      // The workspace graph this rule once read dropped a pattern it did not expand, and with it
      // every package the pattern named.
      const run = yield* decide({
        history: [
          {
            change: {
              "package.json": JSON.stringify({
                name: "root",
                workspaces: [
                  "packages/l*",
                  "packages/apps",
                  "packages/deep",
                  "packages/other",
                  "apps/hosted/cloud",
                  "apps/hosted/cloud/web",
                  "apps/marketing",
                  "apps/docs",
                  "apps/local",
                ],
              }),
            },
            deployed: "success",
          },
        ],
        change: { "packages/lib/src/lib.ts": "export const lib = 2;\n" },
      });
      expect(run.deploy).toBe("true");
      expect(run.summary).toContain("- `packages/lib/src/lib.ts`");
    }),
  );

  it.effect("a decision that cannot write its summary leaves no skip behind", () =>
    Effect.gen(function* () {
      const run = yield* decide({
        history: [],
        change: { "e2e/tests/example.spec.ts": "export const changed = 1;\n" },
        unwritableSummary: true,
      });
      expect(run.exitCode).not.toBe(0);
      expect(run.deploy).toBeUndefined();
    }),
  );

  it.effect("a decision that fails says so apart from a decision to deploy", () =>
    Effect.gen(function* () {
      const run = yield* decide({
        history: [],
        change: { "e2e/tests/example.spec.ts": "export const changed = 1;\n" },
        down: true,
      });
      expect(run.exitCode).toBe(0);
      expect(run.deploy).toBe("true");
      expect(run.summary).toContain("**Could not decide, so deploying:**");
      expect(run.stdout).toContain("::warning title=Deploy decision failed::");
    }),
  );

  it.effect("the workflows deploy unless the decision finished and said skip", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const jobOf = (text: string, name: string) => {
        const start = text.indexOf(`\n  ${name}:\n`);
        expect(start, name).toBeGreaterThan(-1);
        const rest = text.slice(start + 1);
        const end = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
        return end === -1 ? rest : rest.slice(0, end + 1);
      };
      const deploy = yield* fs.readFileString(".github/workflows/deploy.yml");
      const decideJob = jobOf(deploy, "decide");
      expect(decideJob).toContain("      deploy: ${{ steps.decide.outputs.deploy }}\n");
      expect(decideJob).toContain("        id: decide\n");
      expect(decideJob).toContain(
        "        run: node apps/hosted/cloud/scripts/deploy-decision.ts\n",
      );
      // A decide job that fails or times out leaves the output empty, and the deploy runs. Only
      // the exact output false skips it.
      const deployJob = jobOf(deploy, "deploy");
      expect(deployJob).toContain("    needs: decide\n");
      expect(deployJob).toContain(
        "    if: github.ref == 'refs/heads/main' && !cancelled() && needs.decide.outputs.deploy != 'false'\n",
      );
      // The docs name the newest release npm serves, so a publication deploys them again.
      const release = yield* fs.readFileString(".github/workflows/release-artifacts.yml");
      const redeploy = jobOf(release, "deploy-published");
      // It runs whether publish succeeded or failed after the npm publication, and dispatches
      // only once npm's tag for the channel names this release.
      expect(redeploy).toContain("    needs: [metadata, publish]\n");
      expect(redeploy).toContain(
        "    if: ${{ !cancelled() && github.ref == 'refs/heads/main' && needs.metadata.outputs.publish == 'true' && (needs.publish.result == 'success' || needs.publish.result == 'failure') }}\n",
      );
      expect(redeploy).toContain("https://registry.npmjs.org/-/package/executor/dist-tags");
      expect(redeploy).toContain("'.[$channel] == $version'");
      // The run's conclusion stays the publication's, which Beta reads.
      expect(redeploy).toContain("    continue-on-error: true\n");
      expect(redeploy).toContain("    permissions:\n      actions: write\n    ");
      expect(redeploy).toContain('gh workflow run deploy.yml -R "$GITHUB_REPOSITORY" --ref main');
    }),
  );

  it.effect("a deploy someone asked for and lost while it waited deploys with the next push", () =>
    Effect.gen(function* () {
      const tests = { "e2e/tests/example.spec.ts": "export const changed = 1;\n" };
      // A dispatch (after a release, or after a secret changed) waits behind a running deploy,
      // and the next push's run cancels it before it has any job.
      const dispatch = yield* decide({
        history: [{ change: {}, deployed: "never", event: "workflow_dispatch" }],
        change: tests,
      });
      expect(dispatch.deploy).toBe("true");
      expect(dispatch.summary).toContain("never started its deploy job");
      // A re-run of the last deploy's run, cancelled the same way.
      const rerun = yield* decide({
        base: { reruns: [{ deployed: "never", afterHours: 3 }] },
        history: [],
        change: tests,
      });
      expect(rerun.deploy).toBe("true");
      expect(rerun.summary).toContain("never started its deploy job");
      // A deploy that started after the lost request deployed what it asked for.
      const covered = yield* decide({
        history: [
          { change: {}, deployed: "never", event: "workflow_dispatch" },
          {
            change: { "apps/hosted/cloud/src/main.ts": "export const main = 2;\n" },
            deployed: "success",
          },
        ],
        change: tests,
      });
      expect(covered.deploy).toBe("false");
      // A dispatch that deployed is a base like any other.
      const deployed = yield* decide({
        history: [{ change: {}, deployed: "success", event: "workflow_dispatch" }],
        change: tests,
      });
      expect(deployed.deploy).toBe("false");
      expect(deployed.base).not.toBe(deployed.first);
    }),
  );

  it.effect("every attempt of every run counts, whenever it ran", () =>
    Effect.gen(function* () {
      const main = (value: number) => ({
        "apps/hosted/cloud/src/main.ts": `export const main = ${value};\n`,
      });
      const tests = { "e2e/tests/example.spec.ts": "export const changed = 1;\n" };
      // The last deploy's run, re-run hours later after a newer deploy, fails partway.
      const failedRerun = yield* decide({
        base: { reruns: [{ deployed: "failure", afterHours: 5 }] },
        history: [{ change: main(2), deployed: "success" }],
        change: tests,
      });
      expect(failedRerun.deploy).toBe("true");
      expect(failedRerun.summary).toContain("did not succeed");
      // The same re-run succeeds: production holds the older commit again, and the newer
      // change is compared once more.
      const oldRerun = yield* decide({
        base: { reruns: [{ deployed: "success", afterHours: 5 }] },
        history: [{ change: main(2), deployed: "success" }],
        change: tests,
      });
      expect(oldRerun.deploy).toBe("true");
      expect(oldRerun.base).toBe(oldRerun.first);
      expect(oldRerun.summary).toContain("- `apps/hosted/cloud/src/main.ts`");
      // A run whose first attempt failed and whose re-run succeeded is the base.
      const retried = yield* decide({
        history: [
          {
            change: main(2),
            deployed: "failure",
            reruns: [{ deployed: "success", afterHours: 0.5 }],
          },
        ],
        change: tests,
      });
      expect(retried.deploy).toBe("false");
      expect(retried.base).not.toBe(retried.first);
      // A successful deploy, then a push that reverts it with tests: the revert deploys.
      const reverted = yield* decide({
        history: [{ change: main(2), deployed: "success" }],
        change: { ...main(1), ...tests },
      });
      expect(reverted.deploy).toBe("true");
    }),
  );

  it.effect("a deploy job the history cannot read is a doubt", () =>
    Effect.gen(function* () {
      const revert = {
        "apps/hosted/cloud/src/main.ts": "export const main = 1;\n",
        "e2e/tests/example.spec.ts": "export const changed = 1;\n",
      };
      const change = { "apps/hosted/cloud/src/main.ts": "export const main = 2;\n" };
      // The deploy job was renamed, and the run with it failed partway.
      const renamed = yield* decide({
        history: [{ change, deployed: "failure", jobName: "Deploy production" }],
        change: revert,
      });
      expect(renamed.deploy).toBe("true");
      expect(renamed.summary).toContain("no job named deploy");
      // The deploy job started and lists no step yet.
      const unlisted = yield* decide({
        history: [{ change, deployed: "unlisted" }],
        change: revert,
      });
      expect(unlisted.deploy).toBe("true");
      expect(unlisted.summary).toContain("did not succeed");
    }),
  );

  it.effect("a change to e2e: scripts alone is not a deploy input, and anything more is", () =>
    Effect.gen(function* () {
      const tests = { "e2e/tests/example.spec.ts": "export const changed = 1;\n" };
      // A new spec registers its command; changing or removing one is the same.
      for (const scripts of [
        { "e2e:two": "vitest run --config e2e/two.config.ts" },
        { "e2e:one": "vitest run --config e2e/one-renamed.config.ts" },
      ]) {
        const run = yield* decide({
          history: [],
          change: { ...tests, "package.json": rootManifest({ scripts }) },
        });
        expect(run.deploy, JSON.stringify(scripts)).toBe("false");
        expect(run.summary).toContain(
          "The root `package.json` changed only in `e2e:*` scripts, which no deploy step runs, so it is not counted.",
        );
      }
      // The unsafe direction: anything else in the manifest changes with it.
      const unsafe = {
        "a dependency": rootManifest({
          scripts: { "e2e:two": "vitest run" },
          devDependencies: { typescript: "5.9.4" },
        }),
        "another script": rootManifest({
          scripts: { "e2e:two": "vitest run", build: "node scripts/build-all.ts" },
        }),
        "a new script that is not e2e:": rootManifest({ scripts: { e2e2: "vitest run" } }),
        "a key order that changed": (() => {
          const { name, workspaces, scripts, devDependencies } = JSON.parse(rootManifest());
          return JSON.stringify({ name, workspaces, devDependencies, scripts }, null, 2);
        })(),
        "a manifest that does not parse": `${rootManifest({ scripts: { "e2e:two": "vitest run" } })},`,
      };
      for (const [name, manifest] of Object.entries(unsafe)) {
        const run = yield* decide({ history: [], change: { ...tests, "package.json": manifest } });
        expect(run.deploy, name).toBe("true");
        expect(run.summary, name).toMatch(/- `package\.json`|Could not decide, so deploying/);
      }
      // JSON.parse keeps a duplicated key's last copy, Bun its first: a first `scripts` object that
      // Bun runs must not hide behind an unchanged second one with a new e2e: script.
      const duplicated = (first: Record<string, string>) =>
        rootManifest({ scripts: { "e2e:two": "vitest run" } }).replace(
          '  "scripts": {',
          `  "scripts": ${JSON.stringify(first)},\n  "scripts": {`,
        );
      const hidden = {
        "a duplicated scripts object that changes prepare": duplicated({ prepare: "node evil.ts" }),
        "a duplicated scripts object whose build runs an e2e: script": duplicated({
          build: "bun run e2e:one",
        }),
      };
      for (const [name, manifest] of Object.entries(hidden)) {
        const run = yield* decide({ history: [], change: { ...tests, "package.json": manifest } });
        expect(run.deploy, name).toBe("true");
        expect(run.summary, name).toContain("**Could not decide, so deploying:**");
        expect(run.summary, name).toContain("the root package.json does not read faithfully");
      }
      // The base read the same way: a duplicate there, and a canonical head with only an e2e:
      // change, still counts the manifest.
      const baseDuplicate = yield* decide({
        history: [
          { change: { "package.json": duplicated({ build: "node a.ts" }) }, deployed: "success" },
        ],
        change: {
          ...tests,
          "package.json": rootManifest({ scripts: { "e2e:three": "vitest run" } }),
        },
      });
      expect(baseDuplicate.deploy).toBe("true");
      expect(baseDuplicate.summary).toContain("- `package.json`");
      // A base manifest GitHub does not return cannot be compared: the decision deploys.
      const noBase = yield* decide({
        history: [],
        change: {
          ...tests,
          "package.json": rootManifest({ scripts: { "e2e:two": "vitest run" } }),
        },
        noBaseManifest: true,
      });
      expect(noBase.deploy).toBe("true");
      expect(noBase.summary).toContain("**Could not decide, so deploying:**");
    }),
  );

  it.effect("a root script that runs an e2e: script fails the decision, which deploys", () =>
    Effect.gen(function* () {
      // Were a deploy step to run `build`, a change to `e2e:one` would change what it runs.
      const run = yield* decide({
        history: [
          {
            change: { "package.json": rootManifest({ scripts: { build: "bun run e2e:one" } }) },
            deployed: "success",
          },
        ],
        change: { "e2e/tests/example.spec.ts": "export const changed = 1;\n" },
      });
      expect(run.exitCode).toBe(0);
      expect(run.deploy).toBe("true");
      expect(run.summary).toContain("**Could not decide, so deploying:**");
      expect(run.summary).toContain("root scripts build name an e2e: script");
    }),
  );

  it.effect("a workspace package under a listed path counts only where bun install reads it", () =>
    Effect.gen(function* () {
      // The test accounts and Cloud devtools, and the E2E viewer: no production step reads them.
      for (const file of ["apps/hosted/testing/cli.ts", "e2e/viewer/main.tsx"]) {
        const run = yield* decide({
          history: [],
          change: { [file]: "export const changed = 1;\n" },
        });
        expect(run.deploy, file).toBe("false");
      }
      // A package that runs a script when installed counts in full.
      const installs = yield* decide({
        history: [
          {
            change: {
              "apps/hosted/testing/package.json": JSON.stringify({
                name: "testing",
                scripts: { postinstall: "node setup.ts" },
              }),
            },
            deployed: "success",
          },
        ],
        change: { "apps/hosted/testing/setup.ts": "export const changed = 1;\n" },
      });
      expect(installs.deploy).toBe("true");
      expect(installs.summary).toContain("- `apps/hosted/testing/setup.ts`");
    }),
  );
});
