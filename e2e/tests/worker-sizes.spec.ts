/**
 * The `site` job runs `apps/hosted/cloud/scripts/worker-sizes.ts` to hold a pull request to what
 * it adds to each Cloud Worker's upload. These cases run the script as a process on uploads
 * written beforehand (`--uploads`), as it reads a build's, beside main's (`--base`) and the pull
 * request's description (`--description`), and read its exit code, annotations and step summary.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * One Worker's upload: its bytes, its budget, the sources the bytes come from, and the bytes its
 * entry imports statically.
 */
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

/**
 * One run of the check: `uploads` is what the pull request builds. Main's uploads are `main`
 * unless `base` gives others, or none when main's CI run saved none. Without `description` the
 * run is a push to main.
 */
const check = (input: {
  readonly uploads: Readonly<Record<string, Upload>>;
  readonly base?: Readonly<Record<string, Upload>> | "missing";
  readonly description?: string;
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
        ],
        { env: { GITHUB_STEP_SUMMARY: summary }, extendEnv: true },
      ),
    );
    // The runtime logs a failure to stdout, so the cases read both streams together.
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
      // What grew is named, so the author knows what to trim or justify.
      expect(result.summary).toContain("| `saml` | +50,001 |");
      expect(result.summary).toContain("| dashboard | 3,900,000 | 0 |");
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
          "Main's sizes for this base were not available, so no change is shown and growth is not checked.",
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

/** Main's dashboard Worker, whose entry imports only its runtime and loads the renderer on use. */
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
        // Real figures: the dashboard Worker with its renderer behind import() (the base), and the
        // same Worker after Effect 4.1 pulled the renderer into the entry's chunk.
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
