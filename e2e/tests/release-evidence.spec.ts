/**
 * The release workflow's failed jobs gather their failed scenarios' evidence with
 * `e2e/release-evidence.ts`, in the layout `ci-evidence.ts` reads: `<run>/<target>/report/evidence/
 * <id>/result.json` beside the scenario's files. These cases run it as the workflow does, on
 * synthetic runs and Vitest reports.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const script = "e2e/release-evidence.ts";

const node = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(ChildProcess.make("node", args, { extendEnv: true }));
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode, log };
  }).pipe(Effect.scoped);

/** Write `files`, paths relative to `root`, creating their folders. */
const write = (root: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [relative, text] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(root, relative)), { recursive: true });
      yield* fs.writeFileString(path.join(root, relative), text);
    }
  });

/** Every file under `root`, relative and sorted; none when it does not exist. */
const listing = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(root))) return [];
    const all = yield* fs.readDirectory(root, { recursive: true });
    const files: Array<string> = [];
    for (const entry of all)
      if ((yield* fs.stat(path.join(root, entry))).type === "File")
        files.push(entry.split(path.sep).join("/"));
    return files.toSorted();
  });

layer(NodeServices.layer, { excludeTestServices: true })("release evidence", (it) => {
  it.effect("an e2e run gives each failed scenario's folder with its logs, and nothing else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-e2e-runs-" });
      const scenario = (id: string, status: string, directory: string) => ({
        [`run/local/report/evidence/${id}/result.json`]: JSON.stringify({ id, status }),
        [`run/local/report/evidence/${id}/scenario.json`]: JSON.stringify({
          directory: `C:\\runner\\run\\local/scenarios/${directory}`,
        }),
        [`run/local/report/evidence/${id}/steps.json`]: "[]",
        [`run/local/scenarios/${directory}/server.log`]: `${id} server`,
      });
      yield* write(root, {
        "run/evidence.json": "{}",
        "run/local/run.json": "{}",
        "run/local/report/diagnostics/results.json": "{}",
        ...scenario("aaaaaa11", "passed", "s1"),
        ...scenario("bbbbbb22", "failed", "s2"),
        "run/local/scenarios/s2/cli.log": "cli",
        "run/local/scenarios/s2/background-service/data/diagnostics/executor-local.jsonl": "log",
      });
      const dest = path.join(root, "out");
      const run = yield* node([script, "e2e", dest, root]);
      expect(run.exitCode, run.log).toBe(0);
      expect(yield* listing(dest)).toEqual([
        "run/evidence.json",
        "run/local/report/diagnostics/results.json",
        "run/local/report/evidence/bbbbbb22/background-service-diagnostics/executor-local.jsonl",
        "run/local/report/evidence/bbbbbb22/cli.log",
        "run/local/report/evidence/bbbbbb22/result.json",
        "run/local/report/evidence/bbbbbb22/scenario.json",
        "run/local/report/evidence/bbbbbb22/server.log",
        "run/local/report/evidence/bbbbbb22/steps.json",
        "run/local/run.json",
      ]);

      // A run with no failed scenario gives nothing to upload.
      const green = yield* fs.makeTempDirectoryScoped({ prefix: "executor-e2e-green-" });
      yield* write(green, scenario("cccccc33", "passed", "s3"));
      const none = path.join(green, "out");
      expect((yield* node([script, "e2e", none, green])).exitCode).toBe(0);
      expect(yield* fs.exists(none)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("a Vitest report gives each failed test a result.json and its desktop folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-vitest-reports-" });
      yield* write(root, {
        "report.json": JSON.stringify({
          testResults: [
            {
              name: path.resolve("e2e/tests/desktop-recovery.spec.ts"),
              assertionResults: [
                { title: "it recovers", status: "passed", duration: 10 },
                {
                  title: "it reconnects",
                  status: "failed",
                  duration: 20,
                  failureMessages: ["Error: no window"],
                },
              ],
            },
          ],
        }),
        "failures/failed-1/scenario.json": JSON.stringify({ title: "it reconnects" }),
        "failures/failed-1/window-1.png": "png",
        "failures/failed-2/scenario.json": JSON.stringify({ title: "it recovers" }),
      });
      const dest = path.join(root, "out");
      const run = yield* node([
        script,
        "vitest",
        dest,
        "desktop-recovery",
        path.join(root, "failures"),
        path.join(root, "report.json"),
        path.join(root, "missing.json"),
      ]);
      expect(run.exitCode, run.log).toBe(0);
      const files = yield* listing(dest);
      expect(files).toHaveLength(3);
      const result = files.find((file) => file.endsWith("/result.json"))!;
      expect(result).toMatch(
        /^release\/desktop-recovery\/report\/evidence\/[0-9a-f]{16}\/result\.json$/u,
      );
      expect(JSON.parse(yield* fs.readFileString(path.join(dest, result)))).toMatchObject({
        title: "it reconnects",
        file: "e2e/tests/desktop-recovery.spec.ts",
        target: "desktop-recovery",
        status: "failed",
        errors: ["Error: no window"],
      });
      expect(files.some((file) => file.endsWith("/desktop-1/window-1.png"))).toBe(true);

      // A report whose tests all passed gives nothing to upload.
      const none = path.join(root, "none");
      yield* write(root, {
        "green.json": JSON.stringify({
          testResults: [
            { name: "x.spec.ts", assertionResults: [{ title: "ok", status: "passed" }] },
          ],
        }),
      });
      expect(
        (yield* node([
          script,
          "vitest",
          none,
          "local",
          path.join(root, "failures"),
          path.join(root, "green.json"),
        ])).exitCode,
      ).toBe(0);
      expect(yield* fs.exists(none)).toBe(false);
    }).pipe(Effect.scoped),
  );
});
