import { expect, layer } from "@effect/vitest";
import { createHash, randomUUID } from "node:crypto";
import { Config, Effect, FileSystem, Option, Path, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { localEntryCommand } from "../support/local-entry.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { stdioMcp, stdioMcpStateless } from "../support/stdio-mcp.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQWPX/PwAFgALJpImt0wAAAABJRU5ErkJggg==";
const pdf = Buffer.from("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n%%EOF\n", "latin1");

const reviewApp = (receipt: string) => [
  {
    path: "index.ts",
    content: `
import { defineApp, mutation, object, query, router, string } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({
  tools: router({
    review: mutation({ description: "Review after approval", input: object({}), approval: always() }, async () => ({ reviewed: ${JSON.stringify(receipt)} })),
    echo: query({ description: "Echo a word", input: object({ word: string() }) }, async (_, { word }) => ({ echoed: word })),
    report: query({ description: "Return a chart and a report", input: object({}) }, async () => ({
      chart: { type: "image", mimeType: "image/png", data: ${JSON.stringify(png)} },
      report: { type: "resource", resource: { uri: "file:///reports/Q3%20summary.pdf", mimeType: "application/pdf", blob: ${JSON.stringify(pdf.toString("base64"))} } },
    })),
  }),
}));
`,
  },
  appsManifest,
];

const Search = Schema.fromJsonString(
  Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) }),
);
const Described = Schema.fromJsonString(
  Schema.Struct({
    items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
  }),
);
const Skills = Schema.fromJsonString(
  Schema.Struct({
    skills: Schema.Array(
      Schema.Struct({ name: Schema.String, app: Schema.Struct({ slug: Schema.String }) }),
    ),
  }),
);
const SkillDocument = Schema.Struct({ content: Schema.String, files: Schema.Array(Schema.String) });
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
const Outcome = Schema.Struct({ path: Schema.String, ok: Schema.Boolean, value: Schema.Unknown });
const Failure = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
);
const json = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string,
) => Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);

const localCli = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    processes = yield* ChildProcessSpawner.ChildProcessSpawner,
    target = yield* Target,
    evidence = yield* Evidence;
  const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
    Config.option,
  );
  const entry = path.resolve(
    Option.isSome(packagedEntry) ? packagedEntry.value : "apps/local/server/src/bin.ts",
  );
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-tool-cli-" });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    DO_NOT_TRACK: "1",
    EXECUTOR_API_KEY: Redacted.value(target.apiKey),
  };
  const origin = target.metadata.origin;
  const run = (args: ReadonlyArray<string>, input?: string) =>
    evidence.step(
      `executor ${args.join(" ")}`,
      Effect.scoped(
        Effect.gen(function* () {
          const command = localEntryCommand(entry, [...args, "--host", origin]);
          const child = yield* processes.spawn(
            ChildProcess.make(command.command, command.args, {
              cwd: home,
              extendEnv: false,
              env,
              stdin: input === undefined ? "ignore" : Stream.make(new TextEncoder().encode(input)),
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: "3 seconds",
            }),
          );
          const [code, stdout, stderr] = yield* Effect.all(
            [
              child.exitCode,
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            ],
            { concurrency: 3 },
          ).pipe(Effect.timeout("60 seconds"));
          return { code: Number(code), stdout, stderr };
        }),
      ),
    );
  const ok = (args: ReadonlyArray<string>, input?: string) =>
    run(args, input).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result.code, result.stderr).toBe(0))),
      Effect.map((result) => result.stdout),
    );
  return { run, ok, entry, env, origin, home, fs, path };
});

const deployReviewApp = (receipt: string) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const operator = yield* pairLocalOperator;
    const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
    const deployed = yield* operator.send(
      "POST",
      "/v1/apps/deploy",
      { owner: "local", name: `CLI tools ${receipt.slice(0, 8)}`, files: reviewApp(receipt) },
      headers,
    );
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const { app } = yield* body(Schema.Struct({ app: App }), deployed);
    yield* Effect.addFinalizer(() =>
      operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
    );
    return app;
  });

layer(TestLive, { excludeTestServices: true })("CLI tool commands", (it) => {
  it.effect(scenarios.localCliToolCommands.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const cli = yield* localCli;
        const receipt = randomUUID();
        const app = yield* deployReviewApp(receipt);
        const found = Schema.decodeUnknownSync(Search)(
          yield* cli.ok(["search", "--namespace", app.slug]),
        );
        const pathOf = (tool: string) => {
          const path = found.items.find((item) => item.path.endsWith(`.${tool}`))?.path;
          expect(path, JSON.stringify(found.items)).toBeDefined();
          return path ?? "";
        };
        const review = pathOf("review");
        const echo = pathOf("echo");
        const byWords = Schema.decodeUnknownSync(Search)(
          yield* cli.ok(["search", "Review after approval"]),
        );
        expect(byWords.items.map((item) => item.path)).toContain(review);
        const described = Schema.decodeUnknownSync(Described)(
          yield* cli.ok(["describe", echo, review]),
        );
        expect(described.items.map((item) => item.path)).toEqual([echo, review]);
        expect(described.items[0]?.signature).toContain("word: string");

        expect(JSON.parse(yield* cli.ok(["whoami"]))).toEqual({
          host: cli.origin,
          mcp: `${cli.origin}/mcp`,
          organization: null,
          access: { kind: "all" },
          mode: "model",
          apps: false,
        });

        const skills = Schema.decodeUnknownSync(Skills)(yield* cli.ok(["skills"]));
        expect(skills.skills.map((skill) => `${skill.app.slug}/${skill.name}`)).toContain(
          "executor/executor",
        );
        const entry = json(
          SkillDocument,
          yield* cli.ok(["skills", "--app", "executor", "--name", "executor"]),
        );
        expect(entry.content).toContain("# Executor");
        expect(entry.content).toContain("`app-authoring`");
        expect(entry.files).toContain("feedback.md");
        const guide = json(
          SkillDocument,
          yield* cli.ok(["skills", "--app", "executor", "--name", "app-authoring"]),
        );
        expect(guide.content).toContain("# Build an Executor app");
        expect(guide.files).toContain("ui.md");
        const topic = json(
          SkillDocument,
          yield* cli.ok([
            "skills",
            "--app",
            "executor",
            "--name",
            "app-authoring",
            "--file",
            "ui.md",
          ]),
        );
        expect(topic.content).toContain("withOptimisticUpdate");

        const missingName = yield* cli.run(["skills", "--file", "ui.md"]);
        expect(missingName.code).toBe(1);
        expect(Schema.decodeUnknownSync(Failure)(missingName.stdout).error).toMatchObject({
          code: "ToolFailed",
          message: expect.stringContaining("file needs name, the skill whose file it reads"),
        });
        const unknownApp = yield* cli.run(["skills", "--app", "missing-app-slug"]);
        expect(unknownApp.code).toBe(1);
        expect(Schema.decodeUnknownSync(Failure)(unknownApp.stdout).error).toMatchObject({
          code: "ToolFailed",
          message: expect.stringContaining("No visible app has the slug missing-app-slug."),
        });

        const word = randomUUID();
        const echoed = (stdout: string) => {
          const result = json(Completed, stdout);
          return json(Outcome, JSON.stringify(result.execution.value)).value;
        };
        expect(echoed(yield* cli.ok(["call", echo, "--input", JSON.stringify({ word })]))).toEqual({
          echoed: word,
        });
        const inputFile = cli.path.join(cli.home, "input.json");
        yield* cli.fs.writeFileString(inputFile, JSON.stringify({ word: `${word}-file` }));
        expect(echoed(yield* cli.ok(["call", echo, "--input-file", inputFile]))).toEqual({
          echoed: `${word}-file`,
        });
        expect(
          echoed(
            yield* cli.ok(
              ["call", echo, "--input-file", "-"],
              JSON.stringify({ word: `${word}-stdin` }),
            ),
          ),
        ).toEqual({ echoed: `${word}-stdin` });
        const programFile = cli.path.join(cli.home, "program.js");
        yield* cli.fs.writeFileString(
          programFile,
          `return (await ${echo}({ word: "from-file" })).echoed;`,
        );
        expect(
          json(Completed, yield* cli.ok(["execute", "--file", programFile])).execution.value,
        ).toBe("from-file");
        expect(
          json(Completed, yield* cli.ok(["execute", "--file", "-"], "return 6 * 7")).execution
            .value,
        ).toBe(42);
        expect(
          json(Completed, yield* cli.ok(["execute", "--code", "return 'inline'"])).execution.value,
        ).toBe("inline");

        const report = pathOf("report");
        const Saved = Schema.Struct({ contentIndex: Schema.Number, path: Schema.String });
        const saved = (stdout: string) => {
          const value = json(
            Outcome,
            JSON.stringify(json(Completed, stdout).execution.value),
          ).value;
          return Schema.decodeUnknownSync(Schema.Struct({ chart: Saved, report: Saved }))(value);
        };
        const temporary = saved(yield* cli.ok(["call", report]));
        expect(cli.path.dirname(temporary.chart.path)).toBe(
          cli.path.dirname(temporary.report.path),
        );
        expect(cli.path.basename(temporary.chart.path)).toBe(
          `${temporary.chart.contentIndex}-content.png`,
        );
        expect(cli.path.basename(temporary.report.path)).toBe(
          `${temporary.report.contentIndex}-Q3-summary.pdf`,
        );
        expect(Buffer.from(yield* cli.fs.readFile(temporary.chart.path)).toString("base64")).toBe(
          png,
        );
        expect(Buffer.from(yield* cli.fs.readFile(temporary.report.path))).toEqual(pdf);
        yield* cli.fs.remove(cli.path.dirname(temporary.report.path), { recursive: true });
        const directory = cli.path.join(cli.home, "attachments");
        const chosen = saved(
          yield* cli.ok([
            "execute",
            "--files",
            directory,
            "--code",
            `return { path: "report", ok: true, value: await ${report}({}) };`,
          ]),
        );
        expect(cli.path.dirname(chosen.report.path)).toBe(directory);
        expect(Buffer.from(yield* cli.fs.readFile(chosen.report.path))).toEqual(pdf);
      }),
    ),
  );

  it.effect(scenarios.localCliToolResume.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const cli = yield* localCli;
        const receipt = randomUUID();
        const app = yield* deployReviewApp(receipt);
        const found = Schema.decodeUnknownSync(Search)(
          yield* cli.ok(["search", "--namespace", app.slug]),
        );
        const pathOf = (tool: string) => {
          const path = found.items.find((item) => item.path.endsWith(`.${tool}`))?.path;
          expect(path, JSON.stringify(found.items)).toBeDefined();
          return path ?? "";
        };
        const review = pathOf("review");
        const echo = pathOf("echo");
        const batch = json(
          Completed,
          yield* cli.ok([
            "call",
            "--input",
            JSON.stringify([
              { path: echo, input: { word: "one" } },
              { path: echo, input: { word: "two" } },
            ]),
          ]),
        );
        expect(batch.execution.value).toMatchObject([
          { ok: true, value: { echoed: "one" } },
          { ok: true, value: { echoed: "two" } },
        ]);

        const paused = json(Pending, yield* cli.ok(["call", review]));
        const resumed = json(
          Completed,
          yield* cli.ok(["resume", paused.requestId, "--action", "accept"]),
        );
        expect(json(Outcome, JSON.stringify(resumed.execution.value)).value).toEqual({
          reviewed: receipt,
        });
        expect(
          JSON.parse(yield* cli.ok(["resume", paused.requestId, "--action", "accept"])),
        ).toMatchObject({ status: "unavailable", reason: "answered" });

        const bad = yield* cli.run(["call", echo, "--input", "{not json"]);
        expect(bad.code).toBe(1);
        expect(Schema.decodeUnknownSync(Failure)(bad.stdout).error.code).toBe("InputInvalid");
        const tooMany = yield* cli.run([
          "describe",
          ...Array.from({ length: 21 }, (_, index) => `tools.x.t${index}`),
        ]);
        expect(tooMany.code, tooMany.stdout).toBe(1);
        const refused = Schema.decodeUnknownSync(Failure)(tooMany.stdout).error;
        expect(refused.code).toBe("ToolFailed");
        expect(refused.message).toContain("at most 20");
      }),
    ),
  );

  it.effect(scenarios.localCliMcpRelay.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const cli = yield* localCli;
        const receipt = randomUUID();
        const app = yield* deployReviewApp(receipt);
        const command = localEntryCommand(cli.entry, ["mcp", "--host", cli.origin]);
        const client = yield* stdioMcp({
          command: command.command,
          args: command.args,
          env: cli.env,
        });

        expect(client.instructions).toContain("## What Executor is");
        expect(client.instructions).toContain("The `executor` CLI is available in this shell");
        expect(yield* client.tools).toEqual(
          expect.arrayContaining(["skills", "search", "describe", "call", "execute", "resume"]),
        );
        const executed = Schema.decodeUnknownSync(Completed)(
          yield* client.call("execute", { code: "return [6 * 7, 'relayed'].join(':')" }),
        );
        expect(executed.execution.value).toBe("42:relayed");

        const found = Schema.decodeUnknownSync(Search.to)(
          yield* client.call("search", { namespace: app.slug }),
        );
        const review = found.items.find((item) => item.path.endsWith(".review"))?.path;
        expect(review, JSON.stringify(found.items)).toBeDefined();
        const paused = Schema.decodeUnknownSync(Pending)(
          yield* client.call("call", { calls: { path: review ?? "", input: {} } }),
        );
        const resumed = Schema.decodeUnknownSync(Completed)(
          yield* client.call("resume", {
            requestId: paused.requestId,
            response: { action: "accept" },
          }),
        );
        expect(resumed.execution.value).toMatchObject({ ok: true, value: { reviewed: receipt } });
      }),
    ),
  );

  it.effect(scenarios.localCliMcpRelayStateless.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const cli = yield* localCli;
        const evidence = yield* Evidence;
        const command = localEntryCommand(cli.entry, ["mcp", "--host", cli.origin]);
        const client = yield* stdioMcpStateless({
          command: command.command,
          args: command.args,
          env: cli.env,
        });

        expect(client.revision).toBe("2026-07-28");
        expect(client.capabilities?.extensions?.["io.modelcontextprotocol/skills"]).toEqual({
          directoryRead: true,
        });
        expect(client.instructions).toContain("## What Executor is");
        expect(client.instructions).toContain("The `executor` CLI is available in this shell");

        const tools = yield* client.use((mcp) => mcp.listTools());
        expect(tools.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["skills", "search", "describe", "call", "execute", "resume"]),
        );
        const executed = yield* client.use((mcp) =>
          mcp.callTool({
            name: "execute",
            arguments: { code: "return [6 * 7, 'stateless'].join(':')" },
          }),
        );
        expect(
          Schema.decodeUnknownSync(Completed)(executed.structuredContent).execution.value,
        ).toBe("42:stateless");

        expect(yield* client.refusal((mcp) => mcp.request({ method: "prompts/list" }))).toBe(
          -32601,
        );

        const listing = yield* client.use((_, skills) => skills.list());
        yield* evidence.json("stateless-skills-listing.json", listing);
        const entry = listing.skills.find(
          (skill) => skill.uri === "skill://executor/executor/SKILL.md",
        );
        if (entry === undefined)
          return yield* Effect.die(
            `The Executor app's entry skill was not listed: ${JSON.stringify(listing.skills.map((skill) => skill.uri))}`,
          );
        const got = yield* client.use((_, skills) => skills.get(entry.uri));
        expect(got.skill).toEqual(entry);
        const listed = entry.resources === "dynamic" ? [] : entry.resources;
        const document = listed.find((resource) => resource.uri === entry.uri);
        expect(document, JSON.stringify(listed)).toBeDefined();
        const file = yield* client.use((_, skills) => skills.read(entry, entry.uri));
        expect(file.verified).toBe(true);
        expect(file.bytes.byteLength).toBe(document?.size);
        expect(`sha256:${createHash("sha256").update(file.bytes).digest("hex")}`).toBe(
          document?.digest,
        );
      }),
    ),
  );

  it.effect(scenarios.localCliMcpRelayRestart.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const cli = yield* localCli;
        const receipt = randomUUID();
        const app = yield* deployReviewApp(receipt);
        const command = localEntryCommand(cli.entry, ["mcp", "--host", cli.origin]);
        const client = yield* stdioMcp({
          command: command.command,
          args: command.args,
          env: cli.env,
        });
        const echo = (word: string) =>
          client
            .call("execute", {
              code: `return (await tools[${JSON.stringify(app.slug)}].echo({ word: ${JSON.stringify(word)} })).echoed`,
            })
            .pipe(
              Effect.map((result) => Schema.decodeUnknownSync(Completed)(result).execution.value),
            );
        expect(yield* echo("before")).toBe("before");

        yield* serverControl("restart");

        expect(yield* echo("after")).toBe("after");
        expect(yield* client.tools).toEqual(
          expect.arrayContaining(["search", "call", "execute", "resume"]),
        );
      }),
    ),
  );
});
