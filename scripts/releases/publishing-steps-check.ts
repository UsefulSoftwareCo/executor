import { readFileSync } from "node:fs";
import { classificationProblems, publishingFailures, type RunJob } from "./publishing-steps.ts";

const [command, artifacts, runtime] = process.argv.slice(2);
const workflows = {
  "release-artifacts.yml": readFileSync(
    artifacts ?? ".github/workflows/release-artifacts.yml",
    "utf8",
  ),
  "bun-runtime.yml": readFileSync(runtime ?? ".github/workflows/bun-runtime.yml", "utf8"),
};
if (command === "check") {
  const problems = classificationProblems(workflows);
  for (const problem of problems) console.log(problem);
  process.exitCode = problems.length === 0 ? 0 : 1;
} else if (command === "classify") {
  const jobs = JSON.parse(readFileSync(0, "utf8")) as ReadonlyArray<RunJob>;
  console.log(JSON.stringify(publishingFailures(jobs, workflows)));
} else {
  console.error(
    "Usage: node scripts/releases/publishing-steps-check.ts check|classify [release-artifacts.yml] [bun-runtime.yml] (classify reads jobs.json on stdin)",
  );
  process.exitCode = 2;
}
