import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface Summary {
  readonly median: number;
  readonly min: number;
}
interface Measured {
  readonly staticModules: { readonly base: number; readonly head: number };
  readonly staticBytes: { readonly base: number; readonly head: number };
  readonly compile: { readonly base: Summary; readonly head: Summary };
  readonly evaluate: { readonly base: Summary; readonly head: Summary };
}
interface Harness {
  readonly workerd: string;
  readonly runs: number;
  readonly machine: unknown;
  readonly workers: Readonly<Record<string, Measured>>;
  readonly skipped: Readonly<Record<string, string>>;
}

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  console.error("Usage: node scripts/ci/worker-startup-record.ts <harness.json> <record.json>");
  process.exit(2);
}
const commit = process.env["HEAD_SHA"] ?? "";
const before = process.env["BEFORE_SHA"] ?? "";
const base = process.env["BASE_COMMIT"] ?? "";
if (!/^[0-9a-f]{40}$/.test(commit) || (base !== "" && !/^[0-9a-f]{40}$/.test(base))) {
  console.error("HEAD_SHA must be a commit, and BASE_COMMIT a commit or empty.");
  process.exit(2);
}
const harness = JSON.parse(readFileSync(input, "utf8")) as Harness;
const alone = base === "";
const pick = ({ median, min }: Summary) => ({ median, min });
const timing = (times: { readonly base: Summary; readonly head: Summary }) => ({
  base: alone ? null : pick(times.base),
  head: pick(times.head),
  difference: alone ? null : times.head.median - times.base.median,
});
const workers = Object.fromEntries(
  Object.entries(harness.workers).map(([worker, measured]) => [
    worker,
    {
      staticBytes: {
        base: alone ? null : measured.staticBytes.base,
        head: measured.staticBytes.head,
      },
      chunks: {
        base: alone ? null : measured.staticModules.base,
        head: measured.staticModules.head,
      },
      compile: timing(measured.compile),
      evaluate: timing(measured.evaluate),
    },
  ]),
);
if (Object.keys(workers).length === 0) {
  console.error("The harness measured no Worker.");
  process.exit(1);
}
const record = {
  commit,
  before: before === "" ? null : before,
  base: alone ? null : base,
  workerd: harness.workerd,
  runs: harness.runs,
  machine: harness.machine,
  skipped: harness.skipped,
  workers,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);

const signed = (value: number | null) =>
  value === null ? "" : ` (${value > 0 ? "+" : ""}${value})`;
const cell = (times: ReturnType<typeof timing>) =>
  times.base === null
    ? `${times.head.median}`
    : `${times.base.median} → ${times.head.median}${signed(times.difference)}`;
const table = [
  "## Worker start-up",
  "",
  alone
    ? `${commit.slice(0, 9)} alone: no build of the commit before it was recorded. Median of ${harness.runs} runs in workerd ${harness.workerd}, milliseconds.`
    : `${base.slice(0, 9)} → ${commit.slice(0, 9)}, median of ${harness.runs} runs each, alternating, in workerd ${harness.workerd}; milliseconds. It gates nothing.`,
  "",
  "| Worker | Static bytes | Chunks | Compile | Evaluate |",
  "|---|---:|---:|---:|---:|",
  ...Object.entries(workers).map(
    ([worker, measured]) =>
      `| ${worker} | ${measured.staticBytes.head.toLocaleString("en-US")} | ${measured.chunks.head} | ${cell(measured.compile)} | ${cell(measured.evaluate)} |`,
  ),
  ...Object.entries(harness.skipped).map(
    ([worker, why]) => `| ${worker} | skipped: ${why} | | | |`,
  ),
  "",
].join("\n");
console.log(table);
const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary !== undefined && summary !== "") appendFileSync(summary, `${table}\n`);
