/**
 * A managed local Cloud writes `alchemy dev`'s stdout and stderr to cloud.log line by line, and its
 * readiness wait fails as soon as alchemy prints that it gave up on starting a resource
 * (e2e/support/cloud-environment.ts), with the cause alchemy reports after it. These cases run a
 * child that writes lines in pieces to both pipes, and check the lines and failures the harness
 * reads from it.
 */
import { expect, it, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  followAlchemyDev,
  isAlchemyDevFailure,
  outputLines,
} from "../support/alchemy-dev-output.ts";
import {
  runtimeCrashNote,
  runtimeCrashNotesFor,
  trackRuntimeCrash,
  type RuntimeCrash,
} from "../support/runtime-crashes.ts";

const applyFailed =
  "alchemy dev: apply failed; keeping dev alive so healthy resources keep serving.";
const applyInterrupted =
  "alchemy dev: apply was interrupted internally (a bug in a provider or the engine — please report it with the trace below); keeping dev alive so healthy resources keep serving.";
const runFailed = "alchemy dev: run failed; waiting for the next file change to retry.";
const runInterrupted =
  "alchemy dev: run was interrupted internally (a bug in a provider or the engine — please report it with the trace below); waiting for the next file change to retry.";

/**
 * Writes each piece after the one before has left the process, alternating pipes mid-line. The
 * interrupted message is cut inside the UTF-8 bytes of its dash.
 */
const writer = `
const pieces = JSON.parse(process.argv[1]);
for (const [pipe, base64] of pieces) {
  await new Promise((resolve) => process[pipe].write(Buffer.from(base64, "base64"), resolve));
  await new Promise((resolve) => setTimeout(resolve, 30));
}
`;

const interrupted = Buffer.from(`${applyInterrupted}\n`);
const dash = interrupted.indexOf(Buffer.from("—")) + 1;
const pieces: ReadonlyArray<readonly ["stdout" | "stderr", Buffer]> = [
  ["stderr", Buffer.from("alchemy dev: apply f")],
  ["stdout", Buffer.from("Site build ")],
  ["stderr", Buffer.from(applyFailed.slice("alchemy dev: apply f".length) + "\nError: synth")],
  ["stdout", Buffer.from("progress\n[Dashboard] crea")],
  ["stderr", Buffer.from("etic failure\n")],
  ["stderr", interrupted.subarray(0, dash)],
  ["stdout", Buffer.from("ting\n")],
  ["stderr", interrupted.subarray(dash)],
  ["stdout", Buffer.from("last line without a newline")],
];

layer(NodeServices.layer, { excludeTestServices: true })("alchemy dev output", (it) => {
  it.effect("lines written in pieces to both pipes reach the harness whole", () =>
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* processes.spawn(
        ChildProcess.make("node", [
          "--input-type=module",
          "--eval",
          writer,
          JSON.stringify(pieces.map(([pipe, bytes]) => [pipe, bytes.toString("base64")])),
        ]),
      );
      const lines = Array.from(yield* Stream.runCollect(outputLines(child)));
      expect(yield* child.exitCode).toBe(0);
      expect(lines.toSorted()).toEqual(
        [
          applyFailed,
          "Error: synthetic failure",
          applyInterrupted,
          "Site build progress",
          "[Dashboard] creating",
          "last line without a newline",
        ].toSorted(),
      );
      expect(lines.filter(isAlchemyDevFailure)).toEqual([applyFailed, applyInterrupted]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a run that gives up while planning is reported with the cause alchemy prints after it",
    () =>
      Effect.gen(function* () {
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        // As alchemy dev does: the failure and its cause in one write, then a wait for a file
        // change that never comes.
        const report = [
          runFailed,
          "Error: synthetic plan failure",
          "    at computePlan (file:///synthetic/Plan.js:1:1)",
        ];
        const child = yield* processes.spawn(
          ChildProcess.make("node", [
            "--input-type=module",
            "--eval",
            `process.stdout.write("Computing plan\\n");
process.stderr.write(${JSON.stringify(`${report.join("\n")}\n`)});
setInterval(() => {}, 1000);`,
          ]),
        );
        const seen: Array<string> = [];
        const dev = yield* followAlchemyDev(child, (line) => Effect.sync(() => seen.push(line)));
        yield* dev.failed;
        expect(yield* dev.report).toBe(report.join("\n"));
        expect(seen.toSorted()).toEqual(["Computing plan", ...report].toSorted());
        expect(yield* child.isRunning).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("each way alchemy dev reports giving up is a failure, and nothing else is", () =>
    Effect.sync(() => {
      for (const line of [applyFailed, applyInterrupted, runFailed, runInterrupted]) {
        expect(isAlchemyDevFailure(line), line).toBe(true);
      }
      for (const line of [
        "Port 1337 is in use, serving on 1338",
        "[Dashboard] creating",
        "BuildMessage: Unexpected <<",
        `  quoted: ${applyFailed}`,
      ]) {
        expect(isAlchemyDevFailure(line), line).toBe(false);
      }
    }),
  );
});

/**
 * Local Cloud's AppData runtime ran out of memory twice on main on 13 Nov (CI runs 43476304417 and
 * 43477570393). These are its lines from those runs' cloud.log, each at the time the harness read
 * it, and the cases that ran then: the ones that failed while it was down carry a line naming the
 * crash; a case that failed far from it, or passed during it, does not.
 */
const at = (time: string) => Date.parse(`2026-11-13T${time}Z`);
const gcs = "[AppData] <--- Last few GCs --->";
const scavenger =
  "workerd/jsg/setup.c++:38: fatal: V8 fatal error; location = Scavenger: semi-space copy; message = : allocation failed: JavaScript heap out of memory";
const promotion =
  "workerd/jsg/setup.c++:38: fatal: V8 fatal error; location = MarkCompactCollector: young object promotion failed; message = : allocation failed: JavaScript heap out of memory";
const runs = [
  {
    lines: [
      [gcs, "17:54:09.480"],
      [`[AppData] ${scavenger}`, "17:54:09.480"],
      [`[AppData] ${scavenger}`, "17:54:09.481"],
      [
        '[17:54:50.664] WARN (#1044): The Workers runtime for "executor-next-hosted-appdata-ekf4q2rqbwcfqm3sbp2kdluw6" exited unexpectedly (exit code null, signal SIGABRT); starting a replacement on the same ports.',
        "17:54:50.664",
      ],
      [scavenger, "17:54:50.670"],
      [scavenger, "17:54:50.671"],
    ],
    crash: {
      runtime: "appdata",
      cause: "V8 heap out of memory (Scavenger: semi-space copy)",
      crashedAt: at("17:54:09.480"),
      replacedAt: at("17:54:50.664"),
    },
    cases: [
      {
        title: "brotli",
        status: "failed",
        startedAt: at("17:54:15.637"),
        duration: 32411,
        noted: true,
      },
      {
        title: "assistant_first",
        status: "failed",
        startedAt: at("17:54:17.122"),
        duration: 49391,
        noted: true,
      },
      {
        title: "phone guide",
        status: "passed",
        startedAt: at("17:54:16.049"),
        duration: 33100,
        noted: false,
      },
      {
        title: "far before",
        status: "failed",
        startedAt: at("17:50:00.000"),
        duration: 10000,
        noted: false,
      },
      {
        title: "just after",
        status: "failed",
        startedAt: at("17:54:56.000"),
        duration: 4000,
        noted: false,
      },
    ],
  },
  {
    lines: [
      [`[AppData] ${promotion}`, "18:01:39.074"],
      [`[AppData] ${promotion}`, "18:01:39.075"],
      [
        '[18:02:00.038] WARN (#1044): The Workers runtime for "executor-next-hosted-appdata-eiqwyaylhysfechbb3ywxith4" exited unexpectedly (exit code null, signal SIGABRT); starting a replacement on the same ports.',
        "18:02:00.038",
      ],
      [promotion, "18:02:00.050"],
      [promotion, "18:02:00.051"],
    ],
    crash: {
      runtime: "appdata",
      cause: "V8 heap out of memory (MarkCompactCollector: young object promotion failed)",
      crashedAt: at("18:01:39.074"),
      replacedAt: at("18:02:00.038"),
    },
    cases: [
      {
        title: "assistant_first",
        status: "failed",
        startedAt: at("18:01:35.325"),
        duration: 43143,
        noted: true,
      },
      {
        title: "brotli",
        status: "passed",
        startedAt: at("18:01:40.000"),
        duration: 2000,
        noted: false,
      },
    ],
  },
] as const;

it.each(runs.map((run, index) => [index + 1, run] as const))(
  "run %i: one AppData crash, named on each case that failed while it lasted",
  (_, run) => {
    const crashes = run.lines.reduce<ReadonlyArray<RuntimeCrash>>(
      (crashes, [line, time]) => trackRuntimeCrash(crashes, line, at(time)) ?? crashes,
      [],
    );
    expect(crashes).toEqual([run.crash]);
    for (const entry of run.cases)
      expect(runtimeCrashNotesFor(entry, crashes), entry.title).toEqual(
        entry.noted ? [runtimeCrashNote(run.crash)] : [],
      );
    expect(runtimeCrashNote(run.crash)).toContain("Local Cloud's appdata runtime crashed");
  },
);

it("an ordinary log line is no crash", () => {
  for (const line of [
    "[17:54:00.830] ERROR (#11786): CredentialsUnavailable: Cloudflare CI credentials not found.",
    '[AppData] {"message":"The app\'s request failed unexpectedly","level":"ERROR"}',
    gcs,
  ])
    expect(trackRuntimeCrash([], line, at("17:54:00.000")), line).toBeUndefined();
});
