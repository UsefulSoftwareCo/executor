import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer } from "node:http";

const repository = "owner/repository";
const script = "apps/hosted/cloud/scripts/deploy-decision.ts";
const deployStep = "Deploy analytics and the v2 stage";

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

type Deployed = "success" | "failure" | "cancelled" | "running" | "skipped" | "unlisted" | "never";

interface Attempt {
  readonly deployed: Deployed;
  readonly afterHours: number;
}

interface Run {
  readonly id: number;
  readonly sha: string;
  readonly createdAt: string;
  readonly event: "push" | "workflow_dispatch";
  readonly attempts: ReadonlyArray<Attempt>;
  readonly jobName?: string;
}

const hour = 3_600_000;
const at = (time: string, offset: number) => new Date(Date.parse(time) + offset).toISOString();

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

const stubGitHub = (
  runs: ReadonlyArray<Run>,
  down: boolean,
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

interface Earlier {
  readonly deployed: Deployed;
  readonly event?: "push" | "workflow_dispatch";
  readonly reruns?: ReadonlyArray<Attempt>;
  readonly jobName?: string;
}

const decide = (input: {
  readonly base?: Omit<Earlier, "deployed">;
  readonly history: ReadonlyArray<Earlier & { readonly change: Record<string, string> }>;
  readonly change: Record<string, string | null>;
  readonly event?: "push" | "workflow_dispatch";
  readonly down?: boolean;
  readonly unknownBase?: boolean;
  readonly rerun?: boolean;
  readonly attempt?: number;
  readonly unwritableSummary?: boolean;
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
  it.effect(
    "a push that changes only tests, notes, documents, CI scripts or other workflows skips",
    () =>
      Effect.gen(function* () {
        const run = yield* decide({
          history: [],
          change: {
            "e2e/tests/example.spec.ts": "export const changed = 1;\n",
            "notes/ci.md": "Changed note.\n",
            "README.md": "Changed readme.\n",
            ".github/workflows/checks.yml": "name: Changed checks\n",
            "e2e/support/helper.ts": "export const helper = 1;\n",
            "scripts/ci/tool.ts": "export const changed = 1;\n",
          },
        });
        expect(run.exitCode).toBe(0);
        expect(run.deploy).toBe("false");
        expect(run.base).toBe(run.first);
        expect(run.summary).toContain(
          "**Skipped:** every change since the last deploy lies in paths no deploy reads",
        );
        expect(run.summary).toContain(`Base: \`${run.first}\``);
        expect(run.summary).toContain("None of the 6 changed files is a deploy input");
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
        "a release note": { ".changeset/change.md": "Synthetic release note.\n" },
        "a package manifest under a listed path": {
          "e2e/tools/package.json": JSON.stringify({ name: "tools" }),
        },
      };
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

  it.effect(
    "the pushes to main of 24 Nov 2026 skip when they change only CI and deploy when they change the product",
    () =>
      Effect.gen(function* () {
        const changed = (paths: ReadonlyArray<string>) =>
          Object.fromEntries(paths.map((file) => [file, `changed ${file}\n`]));
        const emulatorsScript = {
          "e2e:emulators-server": "vitest run --config e2e/emulators-server.config.ts",
        };
        const partsScript = {
          "e2e:scenario-parts": "vitest run --config e2e/scenario-parts.config.ts",
        };
        const pushes: ReadonlyArray<{
          readonly push: string;
          readonly change: Record<string, string>;
          readonly inputs: ReadonlyArray<string>;
        }> = [
          {
            push: "6fa9d03b9, the tooling split",
            change: changed([
              ".github/workflows/checks.yml",
              "AGENTS.md",
              "RELEASING.md",
              "e2e/README.md",
              "e2e/ci-selection.ts",
              "e2e/tests/ci-repeat.spec.ts",
              "patches/cloudflare-runtime-keep-alive.md",
              "scripts/pr-check.ts",
            ]),
            inputs: [],
          },
          {
            push: "7112e7e68, the emulator control retry",
            change: changed(["e2e/support/emulators.ts", "e2e/tests/emulator-failures.spec.ts"]),
            inputs: [],
          },
          {
            push: "d8d37a0aa, the skip check paging",
            change: changed([
              "e2e/support/emulators.ts",
              "e2e/tests/emulator-failures.spec.ts",
              "e2e/tests/worker-sizes.spec.ts",
              "scripts/ci/worker-baseline.ts",
            ]),
            inputs: [],
          },
          {
            push: "5aac4cd4d, the draft guidance",
            change: changed([
              ".github/pull_request_template.md",
              "AGENTS.md",
              "e2e/ci-selection.ts",
              "e2e/tests/ci-selection.spec.ts",
            ]),
            inputs: [],
          },
          {
            push: "d926ee9ef, the in-job emulator",
            change: {
              ...changed([
                ".github/workflows/checks.yml",
                "e2e/ci-selection.ts",
                "e2e/emulate.json",
                "e2e/emulators-server.config.ts",
                "e2e/sdk/suite.ts",
                "e2e/support/cloud-environment.ts",
                "e2e/support/managed-server.ts",
                "e2e/tests/ci-repeat.spec.ts",
                "e2e/tests/ci-selection.spec.ts",
                "e2e/tests/emulators-server.spec.ts",
                "e2e/tests/failure-text.spec.ts",
                "scripts/ci/e2e-build-job.ts",
                "scripts/ci/emulators-server.ts",
                "scripts/ci/emulators.sh",
                "scripts/e2e-prepare.ts",
              ]),
              "package.json": rootManifest({ scripts: emulatorsScript }),
            },
            inputs: [],
          },
          {
            push: "851363913, the weighted split",
            change: {
              ...changed([
                ".github/workflows/checks.yml",
                "e2e/ci-selection.ts",
                "e2e/run.ts",
                "e2e/scenario-parts.config.ts",
                "e2e/scenario-parts.ts",
                "e2e/scenario-times.json",
                "e2e/tests/ci-selection.spec.ts",
                "e2e/tests/scenario-parts.spec.ts",
                "scripts/ci/scenario-times.ts",
              ]),
              "package.json": rootManifest({ scripts: partsScript }),
            },
            inputs: [],
          },
          {
            push: "a2c8e1bd7, the CLI's stdio relay",
            change: changed([
              "bun.lock",
              "e2e/check-boundary.ts",
              "e2e/support/stdio-mcp.ts",
              "e2e/test-plan.ts",
              "e2e/tests/cli-tool-commands.spec.ts",
              "packages/app-management/package.json",
              "packages/app-management/src/implementation/tools-client.ts",
            ]),
            inputs: [
              "bun.lock",
              "packages/app-management/package.json",
              "packages/app-management/src/implementation/tools-client.ts",
            ],
          },
        ];
        const runs = yield* Effect.forEach(
          pushes,
          ({ change }) => decide({ history: [], change }),
          {
            concurrency: "unbounded",
          },
        );
        for (const [index, run] of runs.entries()) {
          const { push, inputs } = pushes[index]!;
          expect(run.exitCode, push).toBe(0);
          expect(run.deploy, push).toBe(inputs.length === 0 ? "false" : "true");
          for (const input of inputs) expect(run.summary, push).toContain(`- \`${input}\``);
        }
        const mixed = yield* decide({
          history: [],
          change: {
            ...pushes[4]!.change,
            "apps/hosted/cloud/src/main.ts": "export const main = 3;\n",
          },
        });
        expect(mixed.deploy, "a product file beside the largest CI-only push deploys").toBe("true");
        expect(mixed.summary).toContain("- `apps/hosted/cloud/src/main.ts`");
        expect(mixed.summary).not.toContain("- `scripts/ci/emulators.sh`");
      }),
  );

  it.effect("the base is the last commit deployed, not the one before the push", () =>
    Effect.gen(function* () {
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
      const deployJob = jobOf(deploy, "deploy");
      expect(deployJob).toContain("    needs: decide\n");
      expect(deployJob).toContain(
        "    if: github.ref == 'refs/heads/main' && !cancelled() && needs.decide.outputs.deploy != 'false'\n",
      );
      const release = yield* fs.readFileString(".github/workflows/release-artifacts.yml");
      const redeploy = jobOf(release, "deploy-published");
      expect(redeploy).toContain("    needs: [metadata, publish]\n");
      expect(redeploy).toContain(
        "    if: ${{ !cancelled() && github.ref == 'refs/heads/main' && needs.metadata.outputs.publish == 'true' && (needs.publish.result == 'success' || needs.publish.result == 'failure') }}\n",
      );
      expect(redeploy).toContain("https://registry.npmjs.org/-/package/executor/dist-tags");
      expect(redeploy).toContain("'.[$channel] == $version'");
      expect(redeploy).toContain("    continue-on-error: true\n");
      expect(redeploy).toContain("    permissions:\n      actions: write\n    ");
      expect(redeploy).toContain('gh workflow run deploy.yml -R "$GITHUB_REPOSITORY" --ref main');
    }),
  );

  it.effect("a deploy someone asked for and lost while it waited deploys with the next push", () =>
    Effect.gen(function* () {
      const tests = { "e2e/tests/example.spec.ts": "export const changed = 1;\n" };
      const dispatch = yield* decide({
        history: [{ change: {}, deployed: "never", event: "workflow_dispatch" }],
        change: tests,
      });
      expect(dispatch.deploy).toBe("true");
      expect(dispatch.summary).toContain("never started its deploy job");
      const rerun = yield* decide({
        base: { reruns: [{ deployed: "never", afterHours: 3 }] },
        history: [],
        change: tests,
      });
      expect(rerun.deploy).toBe("true");
      expect(rerun.summary).toContain("never started its deploy job");
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
      const failedRerun = yield* decide({
        base: { reruns: [{ deployed: "failure", afterHours: 5 }] },
        history: [{ change: main(2), deployed: "success" }],
        change: tests,
      });
      expect(failedRerun.deploy).toBe("true");
      expect(failedRerun.summary).toContain("did not succeed");
      const oldRerun = yield* decide({
        base: { reruns: [{ deployed: "success", afterHours: 5 }] },
        history: [{ change: main(2), deployed: "success" }],
        change: tests,
      });
      expect(oldRerun.deploy).toBe("true");
      expect(oldRerun.base).toBe(oldRerun.first);
      expect(oldRerun.summary).toContain("- `apps/hosted/cloud/src/main.ts`");
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
      const renamed = yield* decide({
        history: [{ change, deployed: "failure", jobName: "Deploy production" }],
        change: revert,
      });
      expect(renamed.deploy).toBe("true");
      expect(renamed.summary).toContain("no job named deploy");
      const unlisted = yield* decide({
        history: [{ change, deployed: "unlisted" }],
        change: revert,
      });
      expect(unlisted.deploy).toBe("true");
      expect(unlisted.summary).toContain("did not succeed");
    }),
  );

  it.effect("a change to e2e: scripts alone is not a deploy input", () =>
    Effect.gen(function* () {
      const tests = { "e2e/tests/example.spec.ts": "export const changed = 1;\n" };
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
    }),
  );

  it.effect("a root manifest that changes anything but e2e: scripts counts", () =>
    Effect.gen(function* () {
      const tests = { "e2e/tests/example.spec.ts": "export const changed = 1;\n" };
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
    }),
  );

  it.effect("a root manifest Bun may read otherwise, at either end, counts", () =>
    Effect.gen(function* () {
      const tests = { "e2e/tests/example.spec.ts": "export const changed = 1;\n" };
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
      for (const file of ["apps/hosted/testing/cli.ts", "e2e/viewer/main.tsx"]) {
        const run = yield* decide({
          history: [],
          change: { [file]: "export const changed = 1;\n" },
        });
        expect(run.deploy, file).toBe("false");
      }
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
