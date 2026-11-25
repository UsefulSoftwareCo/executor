import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash, randomBytes } from "node:crypto";

const excerptBytes = 256;

const escaped = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) =>
    byte === 0x5c
      ? "\\\\"
      : byte >= 0x20 && byte < 0x7f
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, "0")}`,
  ).join("");

const listFiles = (
  directory: string,
): Effect.Effect<Record<string, number>, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const found: Record<string, number> = {};
    for (const name of yield* fs.readDirectory(directory, { recursive: true })) {
      const info = yield* fs.stat(path.join(directory, name));
      if (info.type === "File") found[name] = Number(info.size);
    }
    return found;
  });

const collect = (
  report: string | Uint8Array,
  extra: Record<string, string> = {},
  name = "coverage-1.json",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = path.resolve(".");
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "executor-coverage-" });
    const run = path.join(workspace, "run");
    const scenario = path.join(run, "local", "coverage", "probe");
    yield* fs.makeDirectory(path.join(scenario, "0"), { recursive: true });
    yield* fs.writeFileString(
      path.join(scenario, "scenario.json"),
      JSON.stringify({ target: "local", title: "Coverage probe" }),
    );
    const file = path.join(scenario, "0", name);
    if (typeof report === "string") yield* fs.writeFileString(file, report);
    else yield* fs.writeFile(file, report);
    for (const [name, text] of Object.entries(extra))
      yield* fs.writeFileString(path.join(scenario, "0", name), text);
    const before = yield* listFiles(run);
    const out = path.join(workspace, "collected.json");
    const child = yield* processes.spawn(
      ChildProcess.make("node", [path.join(root, "e2e/coverage.ts"), "collect", out, run], {
        cwd: root,
        extendEnv: true,
      }),
    );
    const [output, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    const after = yield* listFiles(run);
    const left = yield* Effect.forEach(
      Object.keys(after).filter((name) => !(name in before)),
      (name) => fs.readFileString(path.join(run, name)),
    );
    const info = yield* fs.stat(file);
    return {
      exitCode: Number(exitCode),
      output,
      before,
      after,
      everything: [output, ...left].join("\n"),
      collected: (yield* fs.exists(out)) ? yield* fs.readFileString(out) : undefined,
      relative: path.relative(root, file),
      modified: info.mtime._tag === "Some" ? info.mtime.value.toISOString() : "unknown",
    };
  }).pipe(Effect.scoped);

const longestRun = (text: string, token: string) => {
  let longest = 0;
  for (let start = 0; start < token.length; start++)
    for (
      let end = start + longest + 1;
      end <= token.length && text.includes(token.slice(start, end));
      end++
    )
      longest = end - start;
  return longest;
};

const secretToken = () =>
  `ghp_${Array.from(randomBytes(4096), (byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[byte % 62]).join("")}`;

layer(NodeServices.layer)("Coverage collect on a JSON file it cannot read", (it) => {
  it.effect("a malformed report of 16 MiB fails with a bounded record of it and no copy", () =>
    Effect.gen(function* () {
      const bytes = Buffer.concat([
        Buffer.from("SYNTHETIC_SECRET_DO_NOT_UPLOAD\n"),
        Buffer.alloc(16 * 1024 * 1024, "x"),
      ]);
      const result = yield* collect(bytes);
      expect(result.exitCode, result.output).toBe(1);
      expect(result.after, "collect added or changed a file in the run folder").toEqual(
        result.before,
      );
      expect(result.collected).toBeUndefined();
      expect(result.output).toContain(`${result.relative} could not be read as JSON`);
      expect(result.output).toContain(
        `${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}, modified ${result.modified}.`,
      );
      expect(result.output).toContain(
        "JSON.parse: Unexpected token 'S', not valid JSON; at byte 0",
      );
      expect(result.output).toContain(
        `bytes 0-64: SYNTHETIC_SECRET_DO_NOT_UPLOAD\\x0a${"x".repeat(64 - 31)}`,
      );
      expect(result.output).toContain(
        `bytes ${bytes.length - 64}-${bytes.length}: ${"x".repeat(64)}`,
      );
      expect(result.output.length, result.output).toBeLessThan(2048);
    }),
  );

  it.effect("a long token in a report shows no more of it than the excerpt, wherever it is", () =>
    Effect.gen(function* () {
      const token = secretToken();
      const reports = {
        start: `${token}{"result":[]}`,
        "wrong type": JSON.stringify({ result: token }),
        "error position": `{"result":["${token}",]}`,
        end: `{"result":[]}${token}`,
        "inside a string": `{"result":["${token.slice(0, 2000)}\u0001${token.slice(2000)}"]}`,
      };
      for (const [where, report] of Object.entries(reports)) {
        const result = yield* collect(report);
        expect(result.exitCode, `${where}: ${result.output}`).toBe(1);
        expect(result.after, `${where}: collect added a file`).toEqual(result.before);
        expect(result.output, where).toContain(`${result.relative} could not be read as JSON`);
        expect(result.output, where).toContain(`${Buffer.byteLength(report)} bytes, sha256 `);
        expect(
          longestRun(result.everything, token),
          `${where}: collect showed more of the token than its excerpt`,
        ).toBeLessThanOrEqual(excerptBytes);
      }
    }),
  );

  it.effect("the parser's position is named, and the excerpt is taken around it", () =>
    Effect.gen(function* () {
      const report = `{"result":[{"url":"${"a".repeat(500)}","functions":[1,2,],"pad":"${"b".repeat(500)}"}]}`;
      const result = yield* collect(report);
      expect(result.exitCode, result.output).toBe(1);
      const at = report.indexOf(",]") + 1;
      expect(result.output).toContain(`not valid JSON; at byte ${at})`);
      expect(result.output).toContain(
        `bytes ${at - 64}-${at + 64}: ${report.slice(at - 64, at + 64)}`,
      );
    }),
  );

  it.effect("the byte named is counted in the file's bytes, whatever they decode to", () =>
    Effect.gen(function* () {
      const ff = (count: number) => Buffer.alloc(count, 0xff);
      const pad = Buffer.from(` ${"p".repeat(300)}`);
      const reports: Record<string, [Buffer, number]> = {
        "not UTF-8 before the error": [
          Buffer.concat([Buffer.from('{"result":["'), ff(500), Buffer.from('",]}'), pad]),
          514,
        ],
        "not UTF-8 before a position V8 names": [
          Buffer.concat([Buffer.from('{"result":["'), ff(10), Buffer.from('\u0001"]}'), pad]),
          22,
        ],
        "a cut character before the error": [
          Buffer.concat([
            Buffer.from('{"result":["'),
            Buffer.from("e282".repeat(100), "hex"),
            Buffer.from('",]}'),
            pad,
          ]),
          214,
        ],
        "not UTF-8 at the end": [Buffer.from('{"result":["\xe9', "latin1"), 13],
        "not UTF-8 at the error": [
          Buffer.concat([Buffer.from('{"result":['), ff(3), Buffer.from("]}"), pad]),
          11,
        ],
        "not UTF-8 after the error": [Buffer.concat([Buffer.from('{"result":[1,]'), ff(300)]), 13],
        "two-byte characters before the error": [
          Buffer.concat([Buffer.from(`{"result":["${"é".repeat(100)}",]}`), pad]),
          214,
        ],
        "a byte order mark": [
          Buffer.concat([Buffer.from("efbbbf", "hex"), Buffer.from('{"result":[1,]}'), pad]),
          16,
        ],
      };
      for (const [where, [report, at]] of Object.entries(reports)) {
        const result = yield* collect(report);
        expect(result.exitCode, `${where}: ${result.output}`).toBe(1);
        expect(result.output, where).toContain(`; at byte ${at}).`);
        expect(at, where).toBeLessThanOrEqual(report.length);
        expect(result.output, where).toContain(
          escaped(report.subarray(Math.max(0, at - 32), Math.min(report.length, at + 32))),
        );
      }
    }),
  );

  it.effect("a file no larger than the excerpt is shown whole, and a larger one is not", () =>
    Effect.gen(function* () {
      const report = (size: number) => {
        const text = JSON.stringify({ result: "x" });
        return `${text.slice(0, -2)}${"y".repeat(size - text.length)}"}`;
      };
      for (const size of [1, 199, 255, 256]) {
        const text = size === 1 ? "1" : report(size);
        const result = yield* collect(text);
        expect(result.exitCode, `${size}: ${result.output}`).toBe(1);
        expect(result.output, `${size} bytes`).toContain(`  bytes 0-${size}: ${text}\n`);
      }
      const broken = `{"result":[${"1,".repeat(90)}]}`;
      const parsed = yield* collect(broken);
      expect(parsed.output).toContain(`  bytes 0-${broken.length}: ${broken}\n`);
      const large = report(257);
      const result = yield* collect(large);
      expect(result.output).toContain(`  bytes 0-64: ${large.slice(0, 64)}\n`);
      expect(result.output).toContain(`  bytes 193-257: ${large.slice(193)}`);
      expect(result.output).not.toContain(large.slice(0, 65));
    }),
  );

  it.effect("the path is escaped as the excerpt is, and cut", () =>
    Effect.gen(function* () {
      const name = `${"n".repeat(200)}\u001b[31m\nINJECTED\t\\odd.json`;
      const result = yield* collect("not json", {}, name);
      expect(result.exitCode, result.output).toBe(1);
      const record = result.output.split("\n").find((line) => line.includes("could not be read"));
      expect(record, result.output).toContain(
        `${"n".repeat(100)}\\x1b[31m\\x0aINJECTED\\x09\\\\odd.json could not be read as JSON`,
      );
      expect(
        Array.from(result.output).filter((character) => {
          const code = character.charCodeAt(0);
          return (code < 0x20 && code !== 0x0a) || code === 0x7f;
        }),
        "a control byte from the file's name reached the log",
      ).toEqual([]);
      expect(result.output).not.toContain("\nINJECTED");
      const shown = record!.slice(0, record!.indexOf(" could not be read"));
      const units = shown.replace(/^.*?CoverageFailed: /u, "").match(/\\x[0-9a-f]{2}|\\\\|./gu);
      expect(units!.length, shown).toBeLessThanOrEqual(256 + "...(cut)...".length);
      expect(shown).toContain("...(cut)...");
    }),
  );

  it.effect("a good run's output is unchanged", () =>
    Effect.gen(function* () {
      const result = yield* collect(
        JSON.stringify({ result: [{ url: "file:///elsewhere/a.js", functions: [] }] }),
        {
          "lcov.info": [
            "SF:packages/probe/src/a.ts",
            "DA:1,1",
            "DA:2,0",
            "DA:4,3",
            "end_of_record",
            "SF:e2e/support/b.ts",
            "DA:1,1",
            "end_of_record",
            "",
          ].join("\n"),
        },
      );
      expect(result.exitCode, result.output).toBe(0);
      expect(result.collected).toBe(
        '{"version":1,"targets":{"local":{"executable":{"packages/probe/src/a.ts":"1-2,4"},"scenarios":[{"title":"Coverage probe","covered":{"packages/probe/src/a.ts":"1,4"}}]}}}',
      );
    }),
  );
});
