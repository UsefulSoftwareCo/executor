import { readFileSync } from "node:fs";
import { engineErrorCode } from "../packages/sdk/src/contracts/workflow-errors.ts";

const dependency = "@alchemy.run/cloudflare-runtime";
const { patchedDependencies = {} } = JSON.parse(readFileSync("package.json", "utf8")) as {
  readonly patchedDependencies?: Readonly<Record<string, string>>;
};
const patches = Object.entries(patchedDependencies)
  .filter(([selector]) => selector.startsWith(`${dependency}@`))
  .map(([, path]) => path);
if (patches.length === 0) {
  console.error(`check-engine-refusals: no patch for ${dependency} in package.json.`);
  process.exit(1);
}

const refusal =
  /timestamp\s*<\s*now\s*\)\s*\{?\s*throw\s+(?:new\s+)?Error\(\s*(["\x27`])((?:\\.|(?!\1)[^\\])*)\1/gu;

const failures: Array<string> = [];
let found = 0;
for (const path of patches) {
  const left = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("+++") && (line.startsWith("+") || line.startsWith(" ")))
    .map((line) => line.slice(1))
    .join("\n")
    .replaceAll('\\"', '"');
  for (const match of left.matchAll(refusal)) {
    found += 1;
    const message = match[2]!;
    const code = engineErrorCode(new Error(message));
    if (code !== "past")
      failures.push(
        `${path}: the engine refuses a past time with "${message}", classed "${code}".`,
      );
  }
}
if (found === 0) {
  console.error(
    `check-engine-refusals: found no refusal of a past time (timestamp < now, then a thrown Error) in ${patches.join(", ")}. Update this check to read the engine as the patch now leaves it.`,
  );
  process.exit(1);
}
if (failures.length > 0) {
  console.error(
    [
      ...failures,
      "Add the wording to pastSleep in packages/sdk/src/contracts/workflow-errors.ts, with where it comes from.",
    ].join("\n"),
  );
  process.exit(1);
}
console.log(`check-engine-refusals: ${found} refusals of a past time, all classed past.`);
